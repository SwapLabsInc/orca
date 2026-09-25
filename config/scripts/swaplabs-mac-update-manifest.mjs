#!/usr/bin/env node
// LOCAL: the SwapLabs macOS update manifest — the pipeline's half of the asset
// contract the fork's custom macOS updater consumes (plan §13.1). Per release and
// architecture the mac leg uploads `orca-macos-<arch>.zip`, then this manifest's
// detached Ed25519 signature, then the manifest itself. The manifest bytes are
// canonical (fixed key order, no whitespace, no trailing newline) so the signature
// covers exactly what the app re-reads, and every field is validated at both ends
// because a manifest is the only thing standing between a GitHub asset and a
// replaced app.

import { execFileSync, spawnSync } from 'node:child_process'
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign as signBytes,
  verify as verifyBytes
} from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readFile, stat, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { isSwaplabsBuildVersion } from './swaplabs-build-version.mjs'

export const SWAPLABS_UPDATE_MANIFEST_SCHEMA = 1
export const SWAPLABS_UPDATE_SOURCE = 'swaplabs'
export const SWAPLABS_MAC_BUNDLE_ID = 'com.stablyai.orca'
/** Common name of the fork's self-signed code-signing certificate; the keychain step refuses any other. */
export const SWAPLABS_MAC_SIGN_IDENTITY = 'SwapLabs Orca'
export const SWAPLABS_MAC_ARCHITECTURES = ['arm64', 'x64']
/** Actions secret the mac leg signs with: the Ed25519 private key as PKCS8 PEM. */
export const SWAPLABS_UPDATE_SIGNING_KEY_ENV = 'SWAPLABS_UPDATE_SIGNING_KEY'
/** Build-time env every leg compiles in and the pipeline verifies against: raw 32-byte Ed25519 public key, base64. */
export const SWAPLABS_UPDATE_PUBLIC_KEY_ENV = 'ORCA_SWAPLABS_UPDATE_PUBLIC_KEY'

const ED25519_RAW_PUBLIC_KEY_BYTES = 32
// DER prefix of an Ed25519 SubjectPublicKeyInfo; the raw key is what follows it.
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex')
const MANIFEST_KEY_ORDER = [
  'schema',
  'source',
  'version',
  'arch',
  'file',
  'size',
  'sha512',
  'bundleId',
  'commit',
  'designatedRequirementSha256',
  'releasedAt'
]

export function swaplabsMacUpdateAssetNames(arch) {
  requireArchitecture(arch)
  const manifest = `swaplabs-update-mac-${arch}.json`
  return { zip: `orca-macos-${arch}.zip`, manifest, signature: `${manifest}.sig` }
}

function requireArchitecture(arch) {
  if (!SWAPLABS_MAC_ARCHITECTURES.includes(arch)) {
    throw new Error(
      `arch must be one of ${SWAPLABS_MAC_ARCHITECTURES.join(', ')}: ${JSON.stringify(arch)}`
    )
  }
}

// ---------------------------------------------------------------------------
// Keys

export function parseSwaplabsUpdateSigningKey(pem) {
  if (typeof pem !== 'string' || !pem.trim()) {
    throw new Error(`${SWAPLABS_UPDATE_SIGNING_KEY_ENV} is empty; expected an Ed25519 PKCS8 PEM.`)
  }
  let key
  try {
    key = createPrivateKey({ key: pem, format: 'pem' })
  } catch (error) {
    throw new Error(`${SWAPLABS_UPDATE_SIGNING_KEY_ENV} is not a PEM private key: ${error.message}`)
  }
  if (key.asymmetricKeyType !== 'ed25519') {
    throw new Error(
      `${SWAPLABS_UPDATE_SIGNING_KEY_ENV} is a ${key.asymmetricKeyType} key; the update manifest is signed with Ed25519.`
    )
  }
  return key
}

/** The base64 raw 32-byte public key the Actions variable and the app carry, derived from the private key. */
export function exportSwaplabsUpdatePublicKey(privateKey) {
  const spki = createPublicKey(privateKey).export({ type: 'spki', format: 'der' })
  if (
    spki.length !== ED25519_SPKI_PREFIX.length + ED25519_RAW_PUBLIC_KEY_BYTES ||
    !spki.subarray(0, ED25519_SPKI_PREFIX.length).equals(ED25519_SPKI_PREFIX)
  ) {
    throw new Error('Public key is not an Ed25519 SubjectPublicKeyInfo.')
  }
  return spki.subarray(ED25519_SPKI_PREFIX.length).toString('base64')
}

export function parseSwaplabsUpdatePublicKey(base64) {
  if (typeof base64 !== 'string' || !base64.trim()) {
    throw new Error('Public key is empty; expected a base64 raw 32-byte Ed25519 key.')
  }
  const trimmed = base64.trim()
  const raw = Buffer.from(trimmed, 'base64')
  // Buffer.from silently drops malformed base64; round-trip it so a typo fails here.
  if (
    raw.length !== ED25519_RAW_PUBLIC_KEY_BYTES ||
    raw.toString('base64').replace(/=+$/, '') !== trimmed.replace(/=+$/, '')
  ) {
    throw new Error(
      `Public key must be the base64 of exactly ${ED25519_RAW_PUBLIC_KEY_BYTES} raw Ed25519 bytes.`
    )
  }
  return createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, raw]),
    format: 'der',
    type: 'spki'
  })
}

// ---------------------------------------------------------------------------
// Manifest bytes

const FIELD_PROBLEMS = {
  schema: (value) =>
    value === SWAPLABS_UPDATE_MANIFEST_SCHEMA
      ? null
      : `schema must be ${SWAPLABS_UPDATE_MANIFEST_SCHEMA}`,
  source: (value) =>
    value === SWAPLABS_UPDATE_SOURCE
      ? null
      : `source must be ${JSON.stringify(SWAPLABS_UPDATE_SOURCE)}`,
  version: (value) =>
    isSwaplabsBuildVersion(value)
      ? null
      : 'version must be a SwapLabs build version (<base>-swaplabs.<YYYYMMDDHHMM>[.<delta>])',
  arch: (value) =>
    SWAPLABS_MAC_ARCHITECTURES.includes(value)
      ? null
      : `arch must be one of ${SWAPLABS_MAC_ARCHITECTURES.join(', ')}`,
  file: (value, fields) =>
    SWAPLABS_MAC_ARCHITECTURES.includes(fields.arch) &&
    value === swaplabsMacUpdateAssetNames(fields.arch).zip
      ? null
      : 'file must be orca-macos-<arch>.zip for the manifest arch',
  size: (value) =>
    Number.isSafeInteger(value) && value > 0 ? null : 'size must be a positive integer byte count',
  sha512: (value) =>
    typeof value === 'string' &&
    /^[A-Za-z0-9+/]{86}==$/.test(value) &&
    Buffer.from(value, 'base64').length === 64
      ? null
      : 'sha512 must be the base64 of a 64-byte digest',
  bundleId: (value) =>
    value === SWAPLABS_MAC_BUNDLE_ID ? null : `bundleId must be ${SWAPLABS_MAC_BUNDLE_ID}`,
  commit: (value) =>
    typeof value === 'string' && /^[0-9a-f]{12}$/.test(value)
      ? null
      : 'commit must be 12 lowercase hex characters',
  designatedRequirementSha256: (value) =>
    typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)
      ? null
      : 'designatedRequirementSha256 must be 64 lowercase hex characters',
  // Canonical ISO-8601 UTC only, so the same instant cannot be spelled two ways.
  releasedAt: (value) =>
    typeof value === 'string' &&
    !Number.isNaN(Date.parse(value)) &&
    new Date(value).toISOString() === value
      ? null
      : 'releasedAt must be a canonical ISO-8601 UTC timestamp'
}

export function collectSwaplabsUpdateManifestProblems(fields) {
  if (typeof fields !== 'object' || fields === null || Array.isArray(fields)) {
    return ['manifest must be a JSON object']
  }
  const problems = []
  for (const key of Object.keys(fields)) {
    if (!MANIFEST_KEY_ORDER.includes(key)) {
      problems.push(`unknown field ${JSON.stringify(key)}`)
    }
  }
  for (const key of MANIFEST_KEY_ORDER) {
    const problem = FIELD_PROBLEMS[key](fields[key], fields)
    if (problem) {
      problems.push(problem)
    }
  }
  return problems
}

/** The exact bytes that are uploaded and signed. Throws on any invalid field. */
export function createSwaplabsUpdateManifest(input) {
  const fields = {
    schema: SWAPLABS_UPDATE_MANIFEST_SCHEMA,
    source: SWAPLABS_UPDATE_SOURCE,
    version: input.version,
    arch: input.arch,
    file: SWAPLABS_MAC_ARCHITECTURES.includes(input.arch)
      ? swaplabsMacUpdateAssetNames(input.arch).zip
      : undefined,
    size: input.size,
    sha512: input.sha512,
    bundleId: SWAPLABS_MAC_BUNDLE_ID,
    commit: input.commit,
    designatedRequirementSha256: input.designatedRequirementSha256,
    releasedAt: input.releasedAt
  }
  const problems = collectSwaplabsUpdateManifestProblems(fields)
  if (problems.length > 0) {
    throw new Error(`Invalid update manifest: ${problems.join('; ')}`)
  }
  return canonicalManifestBytes(fields)
}

function canonicalManifestBytes(fields) {
  const ordered = {}
  for (const key of MANIFEST_KEY_ORDER) {
    ordered[key] = fields[key]
  }
  return Buffer.from(JSON.stringify(ordered), 'utf8')
}

/**
 * Parse uploaded manifest bytes. Beyond the field rules, the bytes must be the
 * canonical serialisation of their own content: a pretty-printed or newline-
 * terminated copy is refused even when every field is right, so a consumer can
 * hash and compare bytes without normalising.
 */
export function readSwaplabsUpdateManifest(bytes) {
  let fields
  try {
    fields = JSON.parse(Buffer.from(bytes).toString('utf8'))
  } catch (error) {
    throw new Error(`Update manifest is not JSON: ${error.message}`)
  }
  const problems = collectSwaplabsUpdateManifestProblems(fields)
  if (problems.length === 0 && !canonicalManifestBytes(fields).equals(Buffer.from(bytes))) {
    problems.push(
      'manifest bytes are not the canonical serialisation (key order, no whitespace, no trailing newline)'
    )
  }
  if (problems.length > 0) {
    throw new Error(`Invalid update manifest: ${problems.join('; ')}`)
  }
  return fields
}

// ---------------------------------------------------------------------------
// Signatures

export function signSwaplabsUpdateManifest(manifestBytes, privateKey) {
  return signBytes(null, Buffer.from(manifestBytes), privateKey).toString('base64')
}

export function verifySwaplabsUpdateManifestSignature(manifestBytes, signatureBase64, publicKey) {
  const signature = Buffer.from(String(signatureBase64 ?? '').trim(), 'base64')
  if (signature.length !== 64) {
    return false
  }
  return verifyBytes(null, Buffer.from(manifestBytes), publicKey, signature)
}

// ---------------------------------------------------------------------------
// Designated requirement

/**
 * The text after `designated => ` in `codesign -d -r-` output, which is what the
 * app hashes and compares with its own. Refuses an ad-hoc signature: its
 * requirement is a cdhash that changes with every build, so a manifest carrying
 * it would never match an installed app.
 */
export function parseDesignatedRequirement(codesignOutput) {
  const line = String(codesignOutput ?? '')
    .split(/\r?\n/)
    .find((candidate) => candidate.startsWith('designated => '))
  if (!line) {
    throw new Error('codesign printed no designated requirement; is the bundle signed?')
  }
  const requirement = line.slice('designated => '.length).trim()
  if (/\bcdhash\b/.test(requirement)) {
    throw new Error(
      `The bundle is ad-hoc signed (designated requirement pins a cdhash); it must be signed with "${SWAPLABS_MAC_SIGN_IDENTITY}".`
    )
  }
  if (!requirement.startsWith(`identifier "${SWAPLABS_MAC_BUNDLE_ID}"`)) {
    throw new Error(
      `Designated requirement does not name ${SWAPLABS_MAC_BUNDLE_ID}: ${requirement}`
    )
  }
  return requirement
}

export function hashDesignatedRequirement(requirement) {
  return createHash('sha256').update(requirement, 'utf8').digest('hex')
}

function readAppDesignatedRequirement(appPath) {
  // Both checks are what the updater will run on the extracted bundle; failing
  // here keeps a bundle that would be refused on install out of the release.
  execFileSync('codesign', ['--verify', '--deep', '--strict', appPath], { stdio: 'inherit' })
  // codesign splits `-d` output between stdout and stderr; read both.
  const result = spawnSync('codesign', ['-d', '-r-', appPath], { encoding: 'utf8' })
  if (result.status !== 0) {
    throw new Error(
      `codesign -d -r- failed for ${appPath}: ${result.stderr || result.error?.message}`
    )
  }
  return parseDesignatedRequirement(`${result.stdout}\n${result.stderr}`)
}

// ---------------------------------------------------------------------------
// Zip digest

export async function digestSwaplabsUpdateZip(zipPath) {
  const hash = createHash('sha512')
  let size = 0
  for await (const chunk of createReadStream(zipPath)) {
    hash.update(chunk)
    size += chunk.length
  }
  const expected = (await stat(zipPath)).size
  if (size !== expected) {
    throw new Error(
      `${zipPath} changed while it was being hashed (${size} of ${expected} bytes read).`
    )
  }
  return { size, sha512: hash.digest('base64') }
}

// ---------------------------------------------------------------------------
// Verification (the pipeline's post-upload check; the app performs the same)

export async function verifySwaplabsUpdate({
  manifestBytes,
  signature,
  publicKey,
  zipPath,
  expected
}) {
  const problems = []
  if (!verifySwaplabsUpdateManifestSignature(manifestBytes, signature, publicKey)) {
    problems.push('signature does not verify against the public key')
  }
  let manifest
  try {
    manifest = readSwaplabsUpdateManifest(manifestBytes)
  } catch (error) {
    problems.push(error.message)
    return problems
  }
  for (const key of ['version', 'arch', 'commit']) {
    if (expected?.[key] !== undefined && manifest[key] !== expected[key]) {
      problems.push(
        `${key} is ${JSON.stringify(manifest[key])}, expected ${JSON.stringify(expected[key])}`
      )
    }
  }
  if (zipPath !== undefined) {
    if (basename(zipPath) !== manifest.file) {
      problems.push(`zip is named ${basename(zipPath)} but the manifest points at ${manifest.file}`)
    }
    const digest = await digestSwaplabsUpdateZip(zipPath)
    if (digest.size !== manifest.size) {
      problems.push(`zip is ${digest.size} bytes, manifest says ${manifest.size}`)
    }
    if (digest.sha512 !== manifest.sha512) {
      problems.push('zip sha512 does not match the manifest')
    }
  }
  return problems
}

// ---------------------------------------------------------------------------
// CLI

const USAGE = `Usage:
  swaplabs-mac-update-manifest.mjs emit --arch <arm64|x64> --zip <orca-macos-<arch>.zip> --version <v> --commit <12-hex> --out-dir <dir> (--app <Orca.app> | --designated-requirement <text>) [--released-at <iso>]
      Signs with the Ed25519 key in $${SWAPLABS_UPDATE_SIGNING_KEY_ENV}; writes <out-dir>/swaplabs-update-mac-<arch>.json and .sig.
  swaplabs-mac-update-manifest.mjs verify --arch <arch> --zip <path> --manifest <path> --signature <path> --version <v> --commit <12-hex>
      Verifies with the public key in $${SWAPLABS_UPDATE_PUBLIC_KEY_ENV}.
  swaplabs-mac-update-manifest.mjs public-key
      Prints the base64 public key for the private key in $${SWAPLABS_UPDATE_SIGNING_KEY_ENV}.`

function requireOption(values, name) {
  const value = values[name]
  if (typeof value !== 'string' || !value) {
    throw new Error(`--${name} is required.\n${USAGE}`)
  }
  return value
}

async function emit(values) {
  const arch = requireOption(values, 'arch')
  const zipPath = requireOption(values, 'zip')
  const names = swaplabsMacUpdateAssetNames(arch)
  if (basename(zipPath) !== names.zip) {
    throw new Error(
      `--zip must be named ${names.zip} (the uploaded asset name), got ${basename(zipPath)}.`
    )
  }
  if (values.app && values['designated-requirement']) {
    throw new Error('Pass either --app or --designated-requirement, not both.')
  }
  const requirement = values.app
    ? readAppDesignatedRequirement(values.app)
    : parseDesignatedRequirement(`designated => ${requireOption(values, 'designated-requirement')}`)
  const privateKey = parseSwaplabsUpdateSigningKey(process.env[SWAPLABS_UPDATE_SIGNING_KEY_ENV])
  const digest = await digestSwaplabsUpdateZip(zipPath)
  const manifestBytes = createSwaplabsUpdateManifest({
    version: requireOption(values, 'version'),
    arch,
    size: digest.size,
    sha512: digest.sha512,
    commit: requireOption(values, 'commit'),
    designatedRequirementSha256: hashDesignatedRequirement(requirement),
    releasedAt: values['released-at'] ?? new Date().toISOString()
  })
  const signature = signSwaplabsUpdateManifest(manifestBytes, privateKey)
  const outDir = requireOption(values, 'out-dir')
  await writeFile(join(outDir, names.manifest), manifestBytes)
  await writeFile(join(outDir, names.signature), signature)
  console.log(
    `Wrote ${names.manifest} (+ .sig): ${names.zip} ${digest.size} bytes, sha512 ${digest.sha512}, designated requirement ${requirement}`
  )
}

async function verify(values) {
  const arch = requireOption(values, 'arch')
  const publicKey = parseSwaplabsUpdatePublicKey(process.env[SWAPLABS_UPDATE_PUBLIC_KEY_ENV])
  const manifestPath = requireOption(values, 'manifest')
  const problems = await verifySwaplabsUpdate({
    manifestBytes: await readFile(manifestPath),
    signature: await readFile(requireOption(values, 'signature'), 'utf8'),
    publicKey,
    zipPath: requireOption(values, 'zip'),
    expected: {
      arch,
      version: requireOption(values, 'version'),
      commit: requireOption(values, 'commit')
    }
  })
  if (problems.length > 0) {
    for (const problem of problems) {
      console.error(`::error::${basename(manifestPath)}: ${problem}`)
    }
    process.exit(1)
  }
  console.log(
    `${basename(manifestPath)} verified: signature, fields, zip size and sha512 all match.`
  )
}

async function main(argv) {
  const [command, ...rest] = argv
  const { values } = parseArgs({
    args: rest,
    options: {
      arch: { type: 'string' },
      zip: { type: 'string' },
      app: { type: 'string' },
      'designated-requirement': { type: 'string' },
      version: { type: 'string' },
      commit: { type: 'string' },
      'out-dir': { type: 'string' },
      'released-at': { type: 'string' },
      manifest: { type: 'string' },
      signature: { type: 'string' }
    }
  })
  switch (command) {
    case 'emit':
      return emit(values)
    case 'verify':
      return verify(values)
    case 'public-key':
      console.log(
        exportSwaplabsUpdatePublicKey(
          parseSwaplabsUpdateSigningKey(process.env[SWAPLABS_UPDATE_SIGNING_KEY_ENV])
        )
      )
      return
    default:
      throw new Error(USAGE)
  }
}

// Why the guard: the tests and the setup tool import the functions without running the CLI.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`::error::${error.message}`)
    process.exit(1)
  })
}
