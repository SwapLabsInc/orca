#!/usr/bin/env node
// LOCAL: one-time maintainer tool for the SwapLabs macOS signing material (plan
// §13.1). Generates the self-signed code-signing certificate the mac leg imports
// into a throwaway keychain, and the Ed25519 key pair that signs the update
// manifest, then prints exactly which Actions secrets and variable to create.
// Everything lands in a directory the maintainer names outside the repository;
// nothing here reads or writes GitHub, and no secret is printed.
//
// Runs on macOS or Linux with an `openssl` on PATH (LibreSSL is fine): Node's
// crypto has no X.509 issuer, and the certificate must be a .p12 for
// `security import`.

import { execFileSync } from 'node:child_process'
import { generateKeyPairSync, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import {
  SWAPLABS_MAC_SIGN_IDENTITY,
  SWAPLABS_UPDATE_PUBLIC_KEY_ENV,
  SWAPLABS_UPDATE_SIGNING_KEY_ENV,
  createSwaplabsUpdateManifest,
  exportSwaplabsUpdatePublicKey,
  parseSwaplabsUpdatePublicKey,
  parseSwaplabsUpdateSigningKey,
  signSwaplabsUpdateManifest,
  verifySwaplabsUpdateManifestSignature
} from './swaplabs-mac-update-manifest.mjs'
import { SWAPLABS_RELEASE_SOURCE } from './verify-swaplabs-packaging.mjs'

/** Actions secrets (private) and the one variable (public) the mac leg reads, by name. */
export const SWAPLABS_SIGNING_SECRETS = {
  signingKey: 'SWAPLABS_UPDATE_SIGNING_KEY',
  certificate: 'SWAPLABS_MAC_CERT_P12',
  certificatePassword: 'SWAPLABS_MAC_CERT_PASSWORD'
}
export const SWAPLABS_SIGNING_VARIABLE = 'SWAPLABS_UPDATE_PUBLIC_KEY'

export const SWAPLABS_SIGNING_FILES = {
  signingKey: 'swaplabs-update-signing-key.pem',
  certificate: 'swaplabs-mac-cert.p12',
  certificatePassword: 'swaplabs-mac-cert.password',
  certificatePublic: 'swaplabs-mac-cert.pem'
}
const DEFAULT_VALIDITY_DAYS = 3650
const REPO_ROOT = resolve(import.meta.dirname, '..', '..')

// Why 3DES/SHA-1 for the container: OpenSSL 3 defaults to AES-256 + PBKDF2-SHA256,
// which `security import` on macOS rejects with "MAC verification failed". The
// container only protects the key in transit to an Actions secret; the key
// itself is RSA-2048 and the certificate is SHA-256.
const P12_COMPATIBILITY_ARGS = [
  '-keypbe',
  'PBE-SHA1-3DES',
  '-certpbe',
  'PBE-SHA1-3DES',
  '-macalg',
  'sha1'
]

function opensslConfig(identity) {
  return `[req]
distinguished_name = dn
prompt = no
x509_extensions = codesign

[dn]
CN = ${identity}

# Code Signing EKU is what \`security find-identity -p codesigning\` and codesign
# require; CA:FALSE because the certificate signs code, never other certificates.
[codesign]
basicConstraints = critical, CA:FALSE
keyUsage = critical, digitalSignature
extendedKeyUsage = critical, codeSigning
subjectKeyIdentifier = hash
`
}

export function assertOutsideRepository(outDir, repoRoot = REPO_ROOT) {
  const rel = relative(repoRoot, resolve(outDir))
  // Outside means `relative` had to climb (`..`) or, on Windows, changed drive.
  if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) {
    throw new Error(
      `--out-dir ${outDir} is inside the repository (${repoRoot}); signing material must never be committed. Pick a directory outside it.`
    )
  }
}

function assertNothingToOverwrite(outDir) {
  const present = Object.values(SWAPLABS_SIGNING_FILES).filter((name) =>
    existsSync(join(outDir, name))
  )
  if (present.length > 0) {
    throw new Error(
      `${outDir} already holds ${present.join(', ')}; refusing to overwrite signing material. Move it away first if you mean to rotate.`
    )
  }
}

function openssl(args, { env = {}, cwd } = {}) {
  return execFileSync('openssl', args, {
    cwd,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  })
}

function writePrivate(path, contents) {
  writeFileSync(path, contents, { mode: 0o600 })
}

export function generateSwaplabsSigningMaterial({
  outDir,
  days = DEFAULT_VALIDITY_DAYS,
  identity = SWAPLABS_MAC_SIGN_IDENTITY
}) {
  if (!Number.isSafeInteger(days) || days < 1) {
    throw new Error(`--days must be a positive integer, got ${days}`)
  }
  assertOutsideRepository(outDir)
  mkdirSync(outDir, { recursive: true, mode: 0o700 })
  assertNothingToOverwrite(outDir)

  // Ed25519 pair for the update manifest; the private key is the secret, the raw public key the variable.
  const { privateKey } = generateKeyPairSync('ed25519')
  const signingKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' })
  const publicKey = exportSwaplabsUpdatePublicKey(privateKey)
  const sample = createSwaplabsUpdateManifest({
    version: '0.0.0-swaplabs.202601010000',
    arch: 'arm64',
    size: 1,
    sha512: Buffer.alloc(64).toString('base64'),
    commit: '000000000000',
    designatedRequirementSha256: '0'.repeat(64),
    releasedAt: '2026-01-01T00:00:00.000Z'
  })
  if (
    !verifySwaplabsUpdateManifestSignature(
      sample,
      signSwaplabsUpdateManifest(sample, parseSwaplabsUpdateSigningKey(signingKeyPem)),
      parseSwaplabsUpdatePublicKey(publicKey)
    )
  ) {
    throw new Error('Generated Ed25519 pair failed its sign/verify self-test.')
  }
  writePrivate(join(outDir, SWAPLABS_SIGNING_FILES.signingKey), signingKeyPem)

  // Self-signed code-signing certificate, packed as .p12 with a random password.
  const configPath = join(outDir, 'swaplabs-mac-cert.cnf')
  const keyPath = join(outDir, 'swaplabs-mac-cert.key')
  const certPath = join(outDir, SWAPLABS_SIGNING_FILES.certificatePublic)
  const p12Path = join(outDir, SWAPLABS_SIGNING_FILES.certificate)
  const password = randomBytes(24).toString('base64url')
  try {
    writeFileSync(configPath, opensslConfig(identity))
    openssl([
      'req',
      '-x509',
      '-new',
      '-newkey',
      'rsa:2048',
      '-sha256',
      '-nodes',
      '-days',
      String(days),
      '-config',
      configPath,
      '-keyout',
      keyPath,
      '-out',
      certPath
    ])
    // The password reaches openssl through the environment, never argv.
    openssl(
      [
        'pkcs12',
        '-export',
        '-inkey',
        keyPath,
        '-in',
        certPath,
        '-name',
        identity,
        '-out',
        p12Path,
        '-passout',
        'env:SWAPLABS_MAC_CERT_PASSWORD',
        ...P12_COMPATIBILITY_ARGS
      ],
      { env: { SWAPLABS_MAC_CERT_PASSWORD: password } }
    )
  } finally {
    // The loose key lives on only inside the .p12.
    rmSync(keyPath, { force: true })
    rmSync(configPath, { force: true })
  }
  writePrivate(join(outDir, SWAPLABS_SIGNING_FILES.certificatePassword), `${password}\n`)
  const fingerprint = openssl(['x509', '-in', certPath, '-noout', '-fingerprint', '-sha256'])
    .trim()
    .replace(/^[^=]*=/, '')

  return { outDir, publicKey, fingerprint, identity, days }
}

export function formatSetupInstructions({ outDir, publicKey, fingerprint, identity, days }) {
  const repo = SWAPLABS_RELEASE_SOURCE.repo
  const file = (name) => join(outDir, name)
  return `SwapLabs macOS signing material written to ${outDir}. Keep the directory private; nothing was written to the repository.

  ${SWAPLABS_SIGNING_FILES.signingKey}   Ed25519 private key (PKCS8 PEM) that signs update manifests
  ${SWAPLABS_SIGNING_FILES.certificate}             self-signed code-signing certificate "${identity}" with its RSA key, valid ${days} days
  ${SWAPLABS_SIGNING_FILES.certificatePassword}        password of the .p12
  ${SWAPLABS_SIGNING_FILES.certificatePublic}             the certificate alone (public); SHA-256 fingerprint ${fingerprint}

Create these on ${repo} (Settings → Secrets and variables → Actions), or run:

  gh secret set ${SWAPLABS_SIGNING_SECRETS.signingKey} --repo ${repo} < ${file(SWAPLABS_SIGNING_FILES.signingKey)}
  base64 < ${file(SWAPLABS_SIGNING_FILES.certificate)} | tr -d '\\n' | gh secret set ${SWAPLABS_SIGNING_SECRETS.certificate} --repo ${repo}
  gh secret set ${SWAPLABS_SIGNING_SECRETS.certificatePassword} --repo ${repo} < ${file(SWAPLABS_SIGNING_FILES.certificatePassword)}
  gh variable set ${SWAPLABS_SIGNING_VARIABLE} --repo ${repo} --body '${publicKey}'

${SWAPLABS_SIGNING_VARIABLE} (public, compiled into every fork build as ${SWAPLABS_UPDATE_PUBLIC_KEY_ENV}):

  ${publicKey}

The next push to swaplabs/main signs the macOS bundles with "${identity}" and publishes signed update manifests. Rotating either key strands installed builds: the app accepts only its own certificate's designated requirement, and only manifests signed by the key it was compiled with.
To re-derive the variable from the secret later: ${SWAPLABS_UPDATE_SIGNING_KEY_ENV}="$(cat ${file(SWAPLABS_SIGNING_FILES.signingKey)})" node config/scripts/swaplabs-mac-update-manifest.mjs public-key
`
}

function main() {
  const { values } = parseArgs({
    options: {
      'out-dir': { type: 'string' },
      days: { type: 'string', default: String(DEFAULT_VALIDITY_DAYS) }
    }
  })
  if (!values['out-dir']) {
    throw new Error(
      'Usage: node config/scripts/swaplabs-mac-signing-setup.mjs --out-dir <directory outside the repository> [--days 3650]'
    )
  }
  const result = generateSwaplabsSigningMaterial({
    outDir: resolve(values['out-dir']),
    days: Number(values.days)
  })
  process.stdout.write(formatSetupInstructions(result))
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main()
  } catch (error) {
    console.error(`error: ${error.message}`)
    process.exit(1)
  }
}
