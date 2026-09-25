import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
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

const runSetup = (args) => runProcess({ program: process.execPath, args: [SCRIPT, ...args] })

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
