import { createHash, generateKeyPairSync, sign, type KeyObject } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { vi } from 'vitest'
import type { ProcessResult, ProcessSpec } from '../../../shared/child-process/run-process'
import type { ReleaseSource } from '../../../shared/release-sources'
import { hashDesignatedRequirement } from './mac-self-update-bundle'
import type { ReleaseAssetFetch, ReleaseAssetResponse } from './mac-self-update-download'
import { MacSelfUpdateEngine, type MacSelfUpdateEngineDependencies } from './mac-self-update-engine'
import type { HelperSpawner } from './mac-self-update-helper'
import { createMacSelfUpdatePublicKey } from './mac-self-update-manifest'
import { resolveMacSelfUpdatePaths, type MacSelfUpdatePaths } from './mac-self-update-paths'

/**
 * Test-only: the real engine over a temp directory, with every macOS tool, the network and
 * the helper spawn replaced by fakes. `ditto` is faked by creating the bundle directory the
 * zip would have held; `codesign` and `PlistBuddy` answer from the fixture's manifest.
 */

export const FIXTURE_SOURCE: ReleaseSource = {
  id: 'swaplabs',
  label: 'SwapLabs',
  repo: 'SwapLabsInc/orca',
  prereleaseIdentifier: 'swaplabs'
}
export const FIXTURE_DR = 'identifier "com.stablyai.orca" and certificate leaf = H"deadbeef"'
export const FIXTURE_FEED_URL =
  'https://github.com/SwapLabsInc/orca/releases/download/swaplabs-v1.4.197%2B202609251200'
export const FIXTURE_RELEASE_PAGE_URL =
  'https://github.com/SwapLabsInc/orca/releases/tag/swaplabs-v1.4.197%2B202609251200'

export type MacSelfUpdateEngineFixtureOptions = {
  currentVersion?: string
  targetVersion?: string
  arch?: NodeJS.Architecture
  manifestOverrides?: Record<string, unknown>
  /** Sign the manifest with a key the engine does not trust. */
  signWithForeignKey?: boolean
  /** What the staged bundle's Info.plist reports, when it should disagree with the manifest. */
  stagedBundleVersion?: string
  /** What `codesign -d -r-` prints for the staged bundle. */
  stagedRequirement?: string
  zipStatus?: number
  manifestStatus?: number
}

export type MacSelfUpdateEngineFixture = {
  engine: MacSelfUpdateEngine
  dir: string
  paths: MacSelfUpdatePaths
  spawnHelper: ReturnType<typeof vi.fn<HelperSpawner>>
  requestQuit: ReturnType<typeof vi.fn<() => void>>
  runCalls: ProcessSpec[]
  fetchedUrls: string[]
  manifestBytes: Buffer
  zipBytes: Buffer
  targetVersion: string
  cleanup: () => void
}

function rawPublicKeyBase64(publicKey: KeyObject): string {
  const der = publicKey.export({ type: 'spki', format: 'der' })
  return der.subarray(-32).toString('base64')
}

/** A copy over its own ArrayBuffer, which is what a fetch body chunk is typed as. */
export function toResponseChunk(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(new ArrayBuffer(bytes.length))
  copy.set(bytes)
  return copy
}

/** A fake fetch response streaming `chunks`; `arrayBuffer()` returns them joined. */
export function createReleaseAssetResponse(
  status: number,
  chunks: readonly Uint8Array[]
): ReleaseAssetResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    body: new ReadableStream<Uint8Array<ArrayBuffer>>({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(toResponseChunk(chunk))
        }
        controller.close()
      }
    }),
    arrayBuffer: async () => toResponseChunk(Buffer.concat(chunks)).buffer
  }
}

function respond(status: number, bytes: Buffer): ReleaseAssetResponse {
  const half = Math.ceil(bytes.length / 2)
  return createReleaseAssetResponse(status, [bytes.subarray(0, half), bytes.subarray(half)])
}

export function createMacSelfUpdateEngineFixture(
  options: MacSelfUpdateEngineFixtureOptions = {}
): MacSelfUpdateEngineFixture {
  const arch = options.arch ?? 'arm64'
  const currentVersion = options.currentVersion ?? '1.4.197-swaplabs.202609241530'
  const targetVersion = options.targetVersion ?? '1.4.197-swaplabs.202609251200'
  const dir = mkdtempSync(join(tmpdir(), 'orca-mac-self-update-engine-'))
  const executablePath = join(dir, 'Applications', 'Orca.app', 'Contents', 'MacOS', 'Orca')
  mkdirSync(join(dir, 'Applications', 'Orca.app', 'Contents', 'MacOS'), { recursive: true })
  writeFileSync(executablePath, 'old build')
  const paths = resolveMacSelfUpdatePaths({ executablePath, userDataPath: join(dir, 'userData') })

  const zipBytes = Buffer.from(`zip:${targetVersion}:${'z'.repeat(2048)}`, 'utf8')
  const manifestBytes = Buffer.from(
    JSON.stringify({
      schema: 1,
      source: FIXTURE_SOURCE.id,
      version: targetVersion,
      arch,
      file: `orca-macos-${arch}.zip`,
      size: zipBytes.length,
      sha512: createHash('sha512').update(zipBytes).digest('base64'),
      bundleId: 'com.stablyai.orca',
      commit: 'abcdef123456',
      designatedRequirementSha256: hashDesignatedRequirement(FIXTURE_DR),
      releasedAt: '2026-09-25T12:00:00Z',
      ...options.manifestOverrides
    }),
    'utf8'
  )
  const trusted = generateKeyPairSync('ed25519')
  const signer = options.signWithForeignKey ? generateKeyPairSync('ed25519') : trusted
  const signatureBytes = Buffer.from(
    sign(null, manifestBytes, signer.privateKey).toString('base64')
  )

  const fetchedUrls: string[] = []
  const fetch: ReleaseAssetFetch = async (url) => {
    fetchedUrls.push(url)
    if (url.endsWith('.json')) {
      return respond(options.manifestStatus ?? 200, manifestBytes)
    }
    if (url.endsWith('.sig')) {
      return respond(200, signatureBytes)
    }
    return respond(options.zipStatus ?? 200, zipBytes)
  }

  const runCalls: ProcessSpec[] = []
  const run = async (spec: ProcessSpec): Promise<ProcessResult> => {
    runCalls.push(spec)
    const result: ProcessResult = { code: 0, signal: null, stdout: '', stderr: '', timedOut: false }
    const args = spec.args ?? []
    if (spec.program.endsWith('ditto')) {
      const destination = args.at(-1) ?? ''
      mkdirSync(join(destination, 'Orca.app', 'Contents', 'MacOS'), { recursive: true })
      writeFileSync(join(destination, 'Orca.app', 'Contents', 'MacOS', 'Orca'), 'new build')
      return result
    }
    if (spec.program.endsWith('codesign') && args[0] === '-d') {
      return {
        ...result,
        stderr: `Executable=${args[2]}\ndesignated => ${options.stagedRequirement ?? FIXTURE_DR}\n`
      }
    }
    if (spec.program.endsWith('PlistBuddy')) {
      const key = args[1]
      return {
        ...result,
        stdout:
          key === 'Print :CFBundleIdentifier'
            ? 'com.stablyai.orca\n'
            : `${options.stagedBundleVersion ?? targetVersion}\n`
      }
    }
    if (spec.program.endsWith('xattr') && args[0] === '-p') {
      return { ...result, code: 1, stderr: 'No such xattr: com.apple.quarantine' }
    }
    return result
  }

  const spawnHelper = vi.fn<HelperSpawner>(() => ({ pid: 4242, unref: () => undefined }))
  const requestQuit = vi.fn<() => void>()
  const deps: MacSelfUpdateEngineDependencies = {
    source: FIXTURE_SOURCE,
    publicKey: createMacSelfUpdatePublicKey(rawPublicKeyBase64(trusted.publicKey)),
    arch,
    bundleId: 'com.stablyai.orca',
    paths,
    getCurrentVersion: () => currentVersion,
    readRunningBundleSignature: async () => ({
      designatedRequirementSha256: hashDesignatedRequirement(FIXTURE_DR)
    }),
    fetch,
    run,
    spawnHelper,
    relaunchProgram: '/usr/bin/open',
    requestQuit,
    getPid: () => 1234
  }
  return {
    engine: new MacSelfUpdateEngine(deps),
    dir,
    paths,
    spawnHelper,
    requestQuit,
    runCalls,
    fetchedUrls,
    manifestBytes,
    zipBytes,
    targetVersion,
    cleanup: () => rmSync(dir, { recursive: true, force: true })
  }
}
