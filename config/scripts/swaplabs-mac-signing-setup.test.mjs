import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { runProcess } from '../../src/shared/child-process/run-process'
import {
  SWAPLABS_MAC_SIGN_IDENTITY,
  createSwaplabsUpdateManifest,
  parseSwaplabsUpdatePublicKey,
  parseSwaplabsUpdateSigningKey,
  signSwaplabsUpdateManifest,
  verifySwaplabsUpdateManifestSignature
} from './swaplabs-mac-update-manifest.mjs'
import {
  SWAPLABS_SIGNING_FILES,
  SWAPLABS_SIGNING_SECRETS,
  SWAPLABS_SIGNING_VARIABLE,
  assertOutsideRepository,
  formatSetupInstructions
} from './swaplabs-mac-signing-setup.mjs'

const SCRIPT = fileURLToPath(new URL('./swaplabs-mac-signing-setup.mjs', import.meta.url))
const REPO_ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const hasOpenssl = spawnSync('openssl', ['version'], { encoding: 'utf8' }).status === 0

const runSetup = (args, env = {}) =>
  runProcess({
    program: process.execPath,
    args: [SCRIPT, ...args],
    env: { ...process.env, ...env }
  })
// A case-insensitive checkout (macOS, Windows) resolves an aliased spelling of a real directory.
const caseInsensitive = existsSync(join(REPO_ROOT, 'CONFIG'))

// An `openssl` on PATH that writes every output the way a umask-honouring build
// (LibreSSL, older OpenSSL) does, and records the mode the loose key had while
// it existed: the real one deletes it before the test could look.
function stubOpenssl(directory) {
  const bin = join(directory, 'bin')
  mkdirSync(bin)
  const stub = join(directory, 'openssl-stub.cjs')
  writeFileSync(
    stub,
    `const fs = require('node:fs')
process.umask(0o022)
const args = process.argv.slice(2)
const arg = (flag) => args[args.indexOf(flag) + 1]
if (args[0] === 'req') {
  fs.writeFileSync(arg('-keyout'), 'rsa key')
  fs.writeFileSync(arg('-out'), 'certificate')
  fs.writeFileSync(process.env.STUB_KEY_MODE_FILE, String(fs.statSync(arg('-keyout')).mode & 0o777))
} else if (args[0] === 'pkcs12') {
  fs.writeFileSync(arg('-out'), 'pkcs12')
} else if (args[0] === 'x509') {
  process.stdout.write('sha256 Fingerprint=AA:BB\\n')
}
`
  )
  const launcher = join(bin, 'openssl')
  writeFileSync(launcher, `#!/bin/sh\nexec "${process.execPath}" "${stub}" "$@"\n`)
  chmodSync(launcher, 0o755)
  return { bin, keyModeFile: join(directory, 'key-mode') }
}

describe('swaplabs mac signing setup', () => {
  it('names the secrets and variable the workflow reads', () => {
    expect(SWAPLABS_SIGNING_SECRETS).toEqual({
      signingKey: 'SWAPLABS_UPDATE_SIGNING_KEY',
      certificate: 'SWAPLABS_MAC_CERT_P12',
      certificatePassword: 'SWAPLABS_MAC_CERT_PASSWORD'
    })
    expect(SWAPLABS_SIGNING_VARIABLE).toBe('SWAPLABS_UPDATE_PUBLIC_KEY')
  })

  it('refuses an output directory inside the repository', async () => {
    expect(() => assertOutsideRepository(REPO_ROOT)).toThrow(/inside the repository/)
    expect(() => assertOutsideRepository(join(REPO_ROOT, 'config'))).toThrow(
      /inside the repository/
    )
    expect(() => assertOutsideRepository(join(REPO_ROOT, '..', 'elsewhere'))).not.toThrow()
    const result = await runSetup(['--out-dir', join(REPO_ROOT, 'config', 'never')])
    expect(result.code).not.toBe(0)
    expect(result.stderr).toContain('inside the repository')
  })

  // Where the files land is decided by the filesystem, not by how the path is spelled.
  it('follows a symbolic link before deciding whether the output directory is inside the repository', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'swaplabs-signing-'))
    try {
      const intoRepo = join(directory, 'into-repo')
      symlinkSync(join(REPO_ROOT, 'config'), intoRepo, 'junction')
      expect(() => assertOutsideRepository(intoRepo)).toThrow(/inside the repository/)
      expect(() => assertOutsideRepository(join(intoRepo, 'keys', 'not-yet-created'))).toThrow(
        /inside the repository/
      )
      const result = await runSetup(['--out-dir', join(intoRepo, 'keys')])
      expect(result.code).not.toBe(0)
      expect(result.stderr).toContain('inside the repository')
      expect(existsSync(join(REPO_ROOT, 'config', 'keys'))).toBe(false)

      // The repository itself reached through a link, the target spelled directly.
      const repoLink = join(directory, 'repo')
      symlinkSync(REPO_ROOT, repoLink, 'junction')
      expect(() => assertOutsideRepository(join(REPO_ROOT, 'config'), repoLink)).toThrow(
        /inside the repository/
      )

      const elsewhere = join(directory, 'elsewhere')
      mkdirSync(elsewhere)
      symlinkSync(elsewhere, join(directory, 'out'), 'junction')
      expect(() => assertOutsideRepository(join(directory, 'out', 'keys'))).not.toThrow()

      symlinkSync(join(directory, 'missing'), join(directory, 'dangling'), 'junction')
      expect(() => assertOutsideRepository(join(directory, 'dangling'))).toThrow(
        /cannot be resolved/
      )
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it.skipIf(!caseInsensitive)('refuses a case-aliased spelling of a repository directory', () => {
    expect(() => assertOutsideRepository(join(REPO_ROOT, 'CONFIG', 'keys'))).toThrow(
      /inside the repository/
    )
  })

  it.skipIf(process.platform === 'win32')(
    'keeps the loose key and the .p12 private whatever mode openssl would have used',
    async () => {
      const directory = mkdtempSync(join(tmpdir(), 'swaplabs-signing-'))
      try {
        const { bin, keyModeFile } = stubOpenssl(directory)
        const outDir = join(directory, 'keys')
        const result = await runSetup(['--out-dir', outDir], {
          PATH: `${bin}:${process.env.PATH}`,
          STUB_KEY_MODE_FILE: keyModeFile
        })
        expect(result.code, result.stderr).toBe(0)
        expect(Number(readFileSync(keyModeFile, 'utf8'))).toBe(0o600)
        expect(statSync(join(outDir, SWAPLABS_SIGNING_FILES.certificate)).mode & 0o777).toBe(0o600)
        expect(existsSync(join(outDir, 'swaplabs-mac-cert.key'))).toBe(false)
        expect(result.stdout).toContain('fingerprint AA:BB')

        // A key left behind by a run that died is signing material too.
        rmSync(join(outDir, SWAPLABS_SIGNING_FILES.signingKey))
        writeFileSync(join(outDir, 'swaplabs-mac-cert.key'), 'stale')
        const again = await runSetup(['--out-dir', outDir], { PATH: `${bin}:${process.env.PATH}` })
        expect(again.code).not.toBe(0)
        expect(again.stderr).toContain('swaplabs-mac-cert.key')
        expect(again.stderr).toContain('refusing to overwrite')
      } finally {
        rmSync(directory, { recursive: true, force: true })
      }
    }
  )

  it('prints instructions that name every file, secret and the variable, but no secret value', () => {
    const text = formatSetupInstructions({
      outDir: '/keys',
      publicKey: 'PUBLIC==',
      fingerprint: 'AA:BB',
      identity: SWAPLABS_MAC_SIGN_IDENTITY,
      days: 3650
    })
    for (const name of [
      ...Object.values(SWAPLABS_SIGNING_FILES),
      ...Object.values(SWAPLABS_SIGNING_SECRETS)
    ]) {
      expect(text).toContain(name)
    }
    expect(text).toContain(
      `gh variable set ${SWAPLABS_SIGNING_VARIABLE} --repo SwapLabsInc/orca --body 'PUBLIC=='`
    )
    expect(text).toContain('--repo SwapLabsInc/orca <')
    expect(text).not.toMatch(/BEGIN PRIVATE KEY/)
  })

  it.skipIf(!hasOpenssl)(
    'generates a code-signing certificate, a working Ed25519 pair and the variable value',
    async () => {
      const directory = mkdtempSync(join(tmpdir(), 'swaplabs-signing-'))
      const outDir = join(directory, 'keys')
      try {
        const result = await runSetup(['--out-dir', outDir, '--days', '30'])
        expect(result.code, result.stderr).toBe(0)
        for (const name of Object.values(SWAPLABS_SIGNING_FILES)) {
          expect(statSync(join(outDir, name)).isFile()).toBe(true)
        }
        if (process.platform !== 'win32') {
          for (const key of ['signingKey', 'certificate', 'certificatePassword']) {
            expect(statSync(join(outDir, SWAPLABS_SIGNING_FILES[key])).mode & 0o777).toBe(0o600)
          }
        }
        // The loose key and the openssl config never outlive the run.
        expect(() => statSync(join(outDir, 'swaplabs-mac-cert.key'))).toThrow()
        expect(() => statSync(join(outDir, 'swaplabs-mac-cert.cnf'))).toThrow()

        const publicKey = result.stdout.match(/--body '([^']+)'/)[1]
        const privateKey = parseSwaplabsUpdateSigningKey(
          readFileSync(join(outDir, SWAPLABS_SIGNING_FILES.signingKey), 'utf8')
        )
        const manifest = createSwaplabsUpdateManifest({
          version: '1.4.197-swaplabs.202609241530',
          arch: 'x64',
          size: 1,
          sha512: Buffer.alloc(64).toString('base64'),
          commit: 'abcdef012345',
          designatedRequirementSha256: '0'.repeat(64),
          releasedAt: '2026-09-24T15:30:00.000Z'
        })
        expect(
          verifySwaplabsUpdateManifestSignature(
            manifest,
            signSwaplabsUpdateManifest(manifest, privateKey),
            parseSwaplabsUpdatePublicKey(publicKey)
          )
        ).toBe(true)
        expect(result.stdout).not.toContain(
          readFileSync(join(outDir, SWAPLABS_SIGNING_FILES.certificatePassword), 'utf8').trim()
        )

        const certificate = spawnSync(
          'openssl',
          [
            'x509',
            '-in',
            join(outDir, SWAPLABS_SIGNING_FILES.certificatePublic),
            '-noout',
            '-text'
          ],
          { encoding: 'utf8' }
        ).stdout
        expect(certificate).toMatch(new RegExp(`CN\\s*=\\s*${SWAPLABS_MAC_SIGN_IDENTITY}`))
        expect(certificate).toContain('Code Signing')
        expect(certificate).toContain('Digital Signature')
        expect(certificate).toContain('CA:FALSE')

        // The .p12 opens with the written password and carries the identity by name.
        const container = spawnSync(
          'openssl',
          [
            'pkcs12',
            '-in',
            join(outDir, SWAPLABS_SIGNING_FILES.certificate),
            '-passin',
            'env:P12_PASSWORD',
            '-info',
            '-nokeys'
          ],
          {
            encoding: 'utf8',
            env: {
              ...process.env,
              P12_PASSWORD: readFileSync(
                join(outDir, SWAPLABS_SIGNING_FILES.certificatePassword),
                'utf8'
              ).trim()
            }
          }
        )
        expect(container.status, container.stderr).toBe(0)
        expect(`${container.stdout}${container.stderr}`).toContain(
          `friendlyName: ${SWAPLABS_MAC_SIGN_IDENTITY}`
        )
        expect(`${container.stdout}${container.stderr}`).toContain('TripleDES')

        const again = await runSetup(['--out-dir', outDir])
        expect(again.code).not.toBe(0)
        expect(again.stderr).toContain('refusing to overwrite')
      } finally {
        rmSync(directory, { recursive: true, force: true })
      }
    }
  )

  it('rejects a non-positive validity', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'swaplabs-signing-'))
    try {
      writeFileSync(join(directory, 'marker'), '')
      const result = await runSetup(['--out-dir', join(directory, 'keys'), '--days', '0'])
      expect(result.code).not.toBe(0)
      expect(result.stderr).toContain('--days must be a positive integer')
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
