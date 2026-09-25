import { createHash, generateKeyPairSync } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { runProcess } from '../../src/shared/child-process/run-process'
import {
  SWAPLABS_MAC_SIGN_IDENTITY,
  SWAPLABS_UPDATE_PUBLIC_KEY_ENV,
  SWAPLABS_UPDATE_SIGNING_KEY_ENV,
  collectSwaplabsUpdateManifestProblems,
  createSwaplabsUpdateManifest,
  digestSwaplabsUpdateZip,
  exportSwaplabsUpdatePublicKey,
  hashDesignatedRequirement,
  parseDesignatedRequirement,
  parseSwaplabsUpdatePublicKey,
  parseSwaplabsUpdateSigningKey,
  readSwaplabsUpdateManifest,
  signSwaplabsUpdateManifest,
  swaplabsMacUpdateAssetNames,
  verifySwaplabsUpdate,
  verifySwaplabsUpdateManifestSignature
} from './swaplabs-mac-update-manifest.mjs'

// LOCAL: the asset contract in plan §13.1 is shared with the app-side updater;
// these tests pin the bytes, not just the behaviour.

const SCRIPT = fileURLToPath(new URL('./swaplabs-mac-update-manifest.mjs', import.meta.url))
const VERSION = '1.4.197-swaplabs.202609241530'
const COMMIT = 'abcdef012345'
const DR = `identifier "com.stablyai.orca" and certificate leaf = H"0123456789abcdef0123456789abcdef01234567"`
const RELEASED_AT = '2026-09-24T15:30:00.000Z'
const ZIP_BYTES = Buffer.from('not really a zip, but 34 bytes long')

function keyPair() {
  const { privateKey } = generateKeyPairSync('ed25519')
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' })
  return { pem, privateKey: parseSwaplabsUpdateSigningKey(pem) }
}

function fixtureFields(overrides = {}) {
  return {
    version: VERSION,
    arch: 'arm64',
    size: ZIP_BYTES.length,
    sha512: createHash('sha512').update(ZIP_BYTES).digest('base64'),
    commit: COMMIT,
    designatedRequirementSha256: hashDesignatedRequirement(DR),
    releasedAt: RELEASED_AT,
    ...overrides
  }
}

describe('swaplabs update manifest bytes', () => {
  it('serialises the contract fields in order, compact, with no trailing newline', () => {
    const fields = fixtureFields()
    const bytes = createSwaplabsUpdateManifest(fields)
    expect(bytes.toString('utf8')).toBe(
      `{"schema":1,"source":"swaplabs","version":"${VERSION}","arch":"arm64","file":"orca-macos-arm64.zip",` +
        `"size":${ZIP_BYTES.length},"sha512":"${fields.sha512}","bundleId":"com.stablyai.orca","commit":"${COMMIT}",` +
        `"designatedRequirementSha256":"${fields.designatedRequirementSha256}","releasedAt":"${RELEASED_AT}"}`
    )
    expect(bytes.at(-1)).toBe('}'.charCodeAt(0))
    expect(readSwaplabsUpdateManifest(bytes)).toEqual({
      schema: 1,
      source: 'swaplabs',
      file: 'orca-macos-arm64.zip',
      bundleId: 'com.stablyai.orca',
      ...fields
    })
  })

  it('names the three assets per architecture and nothing else', () => {
    expect(swaplabsMacUpdateAssetNames('x64')).toEqual({
      zip: 'orca-macos-x64.zip',
      manifest: 'swaplabs-update-mac-x64.json',
      signature: 'swaplabs-update-mac-x64.json.sig'
    })
    expect(() => swaplabsMacUpdateAssetNames('universal')).toThrow(/arch must be one of/)
  })

  it.each([
    ['a bare package version', { version: '1.4.197' }, /SwapLabs build version/],
    [
      'a stamped version with a tail semver rejects',
      { version: `${VERSION}.foo bar` },
      /SwapLabs build version/
    ],
    ['an unknown arch', { arch: 'universal' }, /arch must be one of/],
    ['a short commit', { commit: 'abcdef0' }, /12 lowercase hex/],
    ['an uppercase commit', { commit: 'ABCDEF012345' }, /12 lowercase hex/],
    ['a zero size', { size: 0 }, /positive integer/],
    ['a float size', { size: 12.5 }, /positive integer/],
    ['a hex sha512', { sha512: 'ab'.repeat(64) }, /base64 of a 64-byte digest/],
    ['a truncated DR hash', { designatedRequirementSha256: 'ab'.repeat(31) }, /64 lowercase hex/],
    ['a non-UTC timestamp', { releasedAt: '2026-09-24T15:30:00+02:00' }, /canonical ISO-8601/],
    ['a date-only timestamp', { releasedAt: '2026-09-24' }, /canonical ISO-8601/]
  ])('refuses %s', (_name, overrides, message) => {
    expect(() => createSwaplabsUpdateManifest(fixtureFields(overrides))).toThrow(message)
  })

  it('refuses parsed manifests with the wrong constants, extra fields or non-canonical bytes', () => {
    const fields = readSwaplabsUpdateManifest(createSwaplabsUpdateManifest(fixtureFields()))
    expect(collectSwaplabsUpdateManifestProblems({ ...fields, schema: 2 })).toEqual([
      'schema must be 1'
    ])
    expect(collectSwaplabsUpdateManifestProblems({ ...fields, source: 'upstream' })).toEqual([
      'source must be "swaplabs"'
    ])
    expect(collectSwaplabsUpdateManifestProblems({ ...fields, bundleId: 'com.example' })).toEqual([
      'bundleId must be com.stablyai.orca'
    ])
    expect(
      collectSwaplabsUpdateManifestProblems({ ...fields, file: 'orca-macos-x64.zip' })
    ).toEqual(['file must be orca-macos-<arch>.zip for the manifest arch'])
    expect(collectSwaplabsUpdateManifestProblems({ ...fields, url: 'https://x' })).toEqual([
      'unknown field "url"'
    ])
    expect(collectSwaplabsUpdateManifestProblems([])).toEqual(['manifest must be a JSON object'])
    const pretty = Buffer.from(JSON.stringify(fields, null, 2))
    expect(() => readSwaplabsUpdateManifest(pretty)).toThrow(/canonical serialisation/)
    const newline = Buffer.concat([
      createSwaplabsUpdateManifest(fixtureFields()),
      Buffer.from('\n')
    ])
    expect(() => readSwaplabsUpdateManifest(newline)).toThrow(/canonical serialisation/)
    const reordered = Buffer.from(JSON.stringify({ source: 'swaplabs', ...fields }))
    expect(() => readSwaplabsUpdateManifest(reordered)).toThrow(/canonical serialisation/)
    expect(() => readSwaplabsUpdateManifest(Buffer.from('{'))).toThrow(/not JSON/)
  })
})

describe('swaplabs update manifest signatures', () => {
  it('round-trips through the raw base64 public key the variable carries', () => {
    const { privateKey } = keyPair()
    const publicBase64 = exportSwaplabsUpdatePublicKey(privateKey)
    expect(Buffer.from(publicBase64, 'base64')).toHaveLength(32)
    const bytes = createSwaplabsUpdateManifest(fixtureFields())
    const signature = signSwaplabsUpdateManifest(bytes, privateKey)
    expect(Buffer.from(signature, 'base64')).toHaveLength(64)
    const publicKey = parseSwaplabsUpdatePublicKey(publicBase64)
    expect(verifySwaplabsUpdateManifestSignature(bytes, signature, publicKey)).toBe(true)
    expect(verifySwaplabsUpdateManifestSignature(bytes, `${signature}\n`, publicKey)).toBe(true)
  })

  it('detects a tampered manifest, a tampered signature and the wrong key', () => {
    const { privateKey } = keyPair()
    const publicKey = parseSwaplabsUpdatePublicKey(exportSwaplabsUpdatePublicKey(privateKey))
    const bytes = createSwaplabsUpdateManifest(fixtureFields())
    const signature = signSwaplabsUpdateManifest(bytes, privateKey)
    const tampered = Buffer.from(bytes)
    tampered[tampered.indexOf('"size":') + 7] ^= 0x01
    expect(verifySwaplabsUpdateManifestSignature(tampered, signature, publicKey)).toBe(false)
    const brokenSignature = Buffer.from(signature, 'base64')
    brokenSignature[10] ^= 0x80
    expect(
      verifySwaplabsUpdateManifestSignature(bytes, brokenSignature.toString('base64'), publicKey)
    ).toBe(false)
    expect(verifySwaplabsUpdateManifestSignature(bytes, 'AAAA', publicKey)).toBe(false)
    const other = parseSwaplabsUpdatePublicKey(exportSwaplabsUpdatePublicKey(keyPair().privateKey))
    expect(verifySwaplabsUpdateManifestSignature(bytes, signature, other)).toBe(false)
  })

  it('rejects keys that are not Ed25519 or not 32 raw bytes', () => {
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({
      type: 'pkcs8',
      format: 'pem'
    })
    expect(() => parseSwaplabsUpdateSigningKey(rsa)).toThrow(/rsa key; the update manifest/)
    expect(() => parseSwaplabsUpdateSigningKey('')).toThrow(/is empty/)
    expect(() => parseSwaplabsUpdateSigningKey('nope')).toThrow(/not a PEM/)
    expect(() => parseSwaplabsUpdatePublicKey('')).toThrow(/empty/)
    expect(() => parseSwaplabsUpdatePublicKey(Buffer.alloc(31).toString('base64'))).toThrow(
      /exactly 32 raw/
    )
    expect(() => parseSwaplabsUpdatePublicKey('!!!not base64!!!')).toThrow(/exactly 32 raw/)
  })
})

describe('designated requirement', () => {
  it('takes the text after "designated => " from codesign output, trimmed', () => {
    const output = `Executable=/tmp/Orca.app/Contents/MacOS/Orca\ndesignated => ${DR}  \n`
    expect(parseDesignatedRequirement(output)).toBe(DR)
    expect(hashDesignatedRequirement(DR)).toBe(createHash('sha256').update(DR).digest('hex'))
  })

  it('refuses an ad-hoc signature, a missing requirement and another bundle id', () => {
    expect(() =>
      parseDesignatedRequirement('designated => cdhash H"0123456789abcdef0123456789abcdef01234567"')
    ).toThrow(new RegExp(`ad-hoc signed.*${SWAPLABS_MAC_SIGN_IDENTITY}`))
    expect(() => parseDesignatedRequirement('Executable=/tmp/Orca.app\n')).toThrow(/no designated/)
    expect(() =>
      parseDesignatedRequirement('designated => identifier "com.example.other" and anchor apple')
    ).toThrow(/does not name com.stablyai.orca/)
  })
})

describe('swaplabs update verification', () => {
  const setup = () => {
    const directory = mkdtempSync(join(tmpdir(), 'swaplabs-manifest-'))
    const zipPath = join(directory, 'orca-macos-arm64.zip')
    writeFileSync(zipPath, ZIP_BYTES)
    const { pem, privateKey } = keyPair()
    const publicBase64 = exportSwaplabsUpdatePublicKey(privateKey)
    return {
      directory,
      zipPath,
      pem,
      privateKey,
      publicBase64,
      publicKey: parseSwaplabsUpdatePublicKey(publicBase64),
      cleanup: () => rmSync(directory, { recursive: true, force: true })
    }
  }

  it('digests the zip by streaming and reports its size', async () => {
    const context = setup()
    try {
      expect(await digestSwaplabsUpdateZip(context.zipPath)).toEqual({
        size: ZIP_BYTES.length,
        sha512: createHash('sha512').update(ZIP_BYTES).digest('base64')
      })
    } finally {
      context.cleanup()
    }
  })

  it('accepts a matching manifest and lists every mismatch otherwise', async () => {
    const context = setup()
    try {
      const manifestBytes = createSwaplabsUpdateManifest(fixtureFields())
      const signature = signSwaplabsUpdateManifest(manifestBytes, context.privateKey)
      const expected = { version: VERSION, arch: 'arm64', commit: COMMIT }
      const verify = (overrides = {}) =>
        verifySwaplabsUpdate({
          manifestBytes,
          signature,
          publicKey: context.publicKey,
          zipPath: context.zipPath,
          expected,
          ...overrides
        })
      expect(await verify()).toEqual([])
      expect(
        await verify({ expected: { ...expected, version: '1.4.198-swaplabs.202609241531' } })
      ).toEqual([expect.stringContaining('version is')])
      expect(await verify({ expected: { ...expected, arch: 'x64' } })).toEqual([
        expect.stringContaining('arch is')
      ])
      expect(await verify({ expected: { ...expected, commit: '000000000000' } })).toEqual([
        expect.stringContaining('commit is')
      ])
      writeFileSync(context.zipPath, Buffer.concat([ZIP_BYTES, Buffer.from('x')]))
      expect(await verify()).toEqual([
        expect.stringContaining('bytes, manifest says'),
        'zip sha512 does not match the manifest'
      ])
      writeFileSync(context.zipPath, Buffer.from('not really a zip, but 34 bytes lonG'))
      expect(await verify()).toEqual(['zip sha512 does not match the manifest'])
      const renamed = join(context.directory, 'orca-macos-x64.zip')
      writeFileSync(renamed, ZIP_BYTES)
      expect(await verify({ zipPath: renamed })).toEqual([
        expect.stringContaining('named orca-macos-x64.zip')
      ])
      writeFileSync(context.zipPath, ZIP_BYTES)
      expect(await verify({ signature: signature.replace(/^./, 'B') })).toEqual([
        'signature does not verify against the public key'
      ])
      expect(await verify({ manifestBytes: Buffer.from('{}') })).toEqual([
        'signature does not verify against the public key',
        expect.stringContaining('Invalid update manifest')
      ])
    } finally {
      context.cleanup()
    }
  })

  // The CLI is what the workflow runs; drive it as a process so the argument
  // handling and the env contract are covered, not only the functions.
  it('emits and verifies through the CLI, refusing the wrong zip name and key', async () => {
    const context = setup()
    try {
      const run = (args, env = {}) =>
        runProcess({
          program: process.execPath,
          args: [SCRIPT, ...args],
          env: {
            ...process.env,
            [SWAPLABS_UPDATE_SIGNING_KEY_ENV]: '',
            [SWAPLABS_UPDATE_PUBLIC_KEY_ENV]: '',
            ...env
          }
        })
      const emitArgs = [
        'emit',
        '--arch',
        'arm64',
        '--zip',
        context.zipPath,
        '--version',
        VERSION,
        '--commit',
        COMMIT,
        '--out-dir',
        context.directory,
        '--designated-requirement',
        DR,
        '--released-at',
        RELEASED_AT
      ]
      const unsigned = await run(emitArgs)
      expect(unsigned.code).not.toBe(0)
      expect(unsigned.stderr).toContain(`${SWAPLABS_UPDATE_SIGNING_KEY_ENV} is empty`)

      const emitted = await run(emitArgs, { [SWAPLABS_UPDATE_SIGNING_KEY_ENV]: context.pem })
      expect(emitted.code, emitted.stderr).toBe(0)
      expect(emitted.stdout).toContain(`designated requirement ${DR}`)
      const manifestPath = join(context.directory, 'swaplabs-update-mac-arm64.json')
      const signaturePath = `${manifestPath}.sig`
      const manifestBytes = readFileSync(manifestPath)
      expect(manifestBytes.equals(createSwaplabsUpdateManifest(fixtureFields()))).toBe(true)
      expect(readFileSync(signaturePath, 'utf8')).toMatch(/^[A-Za-z0-9+/]{86}==$/)

      const misnamed = join(context.directory, 'Orca-1.4.197-arm64-mac.zip')
      writeFileSync(misnamed, ZIP_BYTES)
      const wrongName = await run(
        emitArgs.map((argument) => (argument === context.zipPath ? misnamed : argument)),
        { [SWAPLABS_UPDATE_SIGNING_KEY_ENV]: context.pem }
      )
      expect(wrongName.code).not.toBe(0)
      expect(wrongName.stderr).toContain('must be named orca-macos-arm64.zip')

      const verifyArgs = [
        'verify',
        '--arch',
        'arm64',
        '--zip',
        context.zipPath,
        '--manifest',
        manifestPath,
        '--signature',
        signaturePath,
        '--version',
        VERSION,
        '--commit',
        COMMIT
      ]
      const verified = await run(verifyArgs, {
        [SWAPLABS_UPDATE_PUBLIC_KEY_ENV]: context.publicBase64
      })
      expect(verified.code, verified.stderr).toBe(0)
      expect(verified.stdout).toContain('verified')

      const noKey = await run(verifyArgs)
      expect(noKey.code).not.toBe(0)
      expect(noKey.stderr).toContain('Public key is empty')

      const otherKey = exportSwaplabsUpdatePublicKey(keyPair().privateKey)
      const wrongKey = await run(verifyArgs, { [SWAPLABS_UPDATE_PUBLIC_KEY_ENV]: otherKey })
      expect(wrongKey.code).not.toBe(0)
      expect(wrongKey.stderr).toContain('signature does not verify')

      writeFileSync(context.zipPath, Buffer.from('tampered'))
      const tampered = await run(verifyArgs, {
        [SWAPLABS_UPDATE_PUBLIC_KEY_ENV]: context.publicBase64
      })
      expect(tampered.code).not.toBe(0)
      expect(tampered.stderr).toContain('sha512 does not match')

      const publicKey = await run(['public-key'], {
        [SWAPLABS_UPDATE_SIGNING_KEY_ENV]: context.pem
      })
      expect(publicKey.code).toBe(0)
      expect(publicKey.stdout.trim()).toBe(context.publicBase64)
    } finally {
      context.cleanup()
    }
  })
})
