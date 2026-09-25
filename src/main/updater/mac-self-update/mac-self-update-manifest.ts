import { createPublicKey, verify as verifyEd25519, type KeyObject } from 'node:crypto'
import { compareAppVersions, isValidAppVersion } from '../../../shared/app-version'
import {
  getMacSelfUpdateZipName,
  isMacSelfUpdateArchitecture,
  type MacSelfUpdateArchitecture
} from '../../../shared/mac-self-update-assets'
import { getVersionReleaseSource, type ReleaseSource } from '../../../shared/release-sources'
import { MacSelfUpdateError } from './mac-self-update-failure'

export const MAC_SELF_UPDATE_MANIFEST_SCHEMA = 1

/** The signed manifest a SwapLabs release publishes per macOS slice (plan §13.1). */
export type MacSelfUpdateManifest = {
  schema: typeof MAC_SELF_UPDATE_MANIFEST_SCHEMA
  source: string
  version: string
  arch: MacSelfUpdateArchitecture
  file: string
  size: number
  /** Base64 sha512 of the zip, the same spelling electron-builder manifests use. */
  sha512: string
  bundleId: string
  commit: string
  /** Hex sha256 of the bundle's designated requirement text after `designated => `, trimmed. */
  designatedRequirementSha256: string
  releasedAt: string
}

/** What the running build expects the manifest to describe; anything else is refused. */
export type MacSelfUpdateExpectation = {
  source: ReleaseSource
  arch: NodeJS.Architecture
  bundleId: string
  currentVersion: string
  /** A pinned jump names its exact target; a routine check takes anything newer. */
  expectedVersion: string | null
  allowDowngrade: boolean
  /** Hex sha256 of the running bundle's designated requirement: the same signing identity. */
  runningDesignatedRequirementSha256: string
}

// SubjectPublicKeyInfo header for an Ed25519 key (RFC 8410), followed by the 32 raw bytes.
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex')
const BASE64_SHA512 = /^[A-Za-z0-9+/]{86}==$/
const HEX_SHA256 = /^[0-9a-f]{64}$/i
const COMMIT_HASH = /^[0-9a-f]{7,40}$/i
const MAX_ZIP_BYTES = 8 * 1024 * 1024 * 1024

export function createMacSelfUpdatePublicKey(rawBase64: string): KeyObject {
  const raw = Buffer.from(rawBase64, 'base64')
  if (raw.length !== 32) {
    throw new MacSelfUpdateError('signature-invalid', 'The update signing key is malformed.')
  }
  return createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, raw]),
    format: 'der',
    type: 'spki'
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function malformed(detail: string): MacSelfUpdateError {
  return new MacSelfUpdateError(
    'manifest-malformed',
    `The SwapLabs update manifest is malformed (${detail}). Nothing was installed.`,
    { retryable: false }
  )
}

function readString(record: Record<string, unknown>, key: string): string {
  const value = record[key]
  if (typeof value !== 'string' || value.length === 0 || value.length > 512) {
    throw malformed(`"${key}" must be a non-empty string`)
  }
  return value
}

/** Structural validation only; every value is still untrusted until `verifyMacSelfUpdateManifest` accepts it. */
export function parseMacSelfUpdateManifest(bytes: Uint8Array): MacSelfUpdateManifest {
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(bytes).toString('utf8'))
  } catch {
    throw malformed('not JSON')
  }
  if (!isRecord(parsed)) {
    throw malformed('not an object')
  }
  const record = parsed
  if (record.schema !== MAC_SELF_UPDATE_MANIFEST_SCHEMA) {
    throw malformed(`schema ${String(record.schema)} is not ${MAC_SELF_UPDATE_MANIFEST_SCHEMA}`)
  }
  const arch = readString(record, 'arch')
  if (!isMacSelfUpdateArchitecture(arch)) {
    throw malformed(`unknown arch "${arch}"`)
  }
  const version = readString(record, 'version')
  if (!isValidAppVersion(version)) {
    throw malformed(`"${version}" is not a version`)
  }
  const file = readString(record, 'file')
  if (file !== getMacSelfUpdateZipName(arch)) {
    throw malformed(`"file" must be ${getMacSelfUpdateZipName(arch)}`)
  }
  const size = record.size
  if (
    typeof size !== 'number' ||
    !Number.isSafeInteger(size) ||
    size <= 0 ||
    size > MAX_ZIP_BYTES
  ) {
    throw malformed('"size" must be a positive byte count')
  }
  const sha512 = readString(record, 'sha512')
  if (!BASE64_SHA512.test(sha512)) {
    throw malformed('"sha512" must be a base64 SHA-512 digest')
  }
  const commit = readString(record, 'commit')
  if (!COMMIT_HASH.test(commit)) {
    throw malformed('"commit" must be a git hash')
  }
  const designatedRequirementSha256 = readString(record, 'designatedRequirementSha256')
  if (!HEX_SHA256.test(designatedRequirementSha256)) {
    throw malformed('"designatedRequirementSha256" must be a hex SHA-256 digest')
  }
  const releasedAt = readString(record, 'releasedAt')
  if (Number.isNaN(Date.parse(releasedAt))) {
    throw malformed('"releasedAt" must be an ISO-8601 timestamp')
  }
  return {
    schema: MAC_SELF_UPDATE_MANIFEST_SCHEMA,
    source: readString(record, 'source'),
    version,
    arch,
    file,
    size,
    sha512,
    bundleId: readString(record, 'bundleId'),
    commit,
    designatedRequirementSha256: designatedRequirementSha256.toLowerCase(),
    releasedAt
  }
}

/** True only when `signatureBase64` is a valid Ed25519 signature over exactly `manifestBytes`. */
export function isMacSelfUpdateSignatureValid(
  manifestBytes: Uint8Array,
  signatureBase64: string,
  publicKey: KeyObject
): boolean {
  const signature = Buffer.from(signatureBase64.trim(), 'base64')
  if (signature.length !== 64) {
    return false
  }
  try {
    return verifyEd25519(null, Buffer.from(manifestBytes), publicKey, signature)
  } catch {
    return false
  }
}

/**
 * The only way bytes from a release become a manifest the installer acts on. Order matters:
 * the signature is checked before anything is parsed, so no unsigned byte shapes a decision.
 */
export function verifyMacSelfUpdateManifest(
  manifestBytes: Uint8Array,
  signatureBase64: string,
  publicKey: KeyObject,
  expected: MacSelfUpdateExpectation
): MacSelfUpdateManifest {
  if (!isMacSelfUpdateSignatureValid(manifestBytes, signatureBase64, publicKey)) {
    throw new MacSelfUpdateError(
      'signature-invalid',
      `The ${expected.source.label} update manifest is not signed by the ${expected.source.label} release key. Nothing was installed.`,
      { retryable: false }
    )
  }
  const manifest = parseMacSelfUpdateManifest(manifestBytes)
  const refuse = (reason: MacSelfUpdateError['reason'], detail: string): never => {
    throw new MacSelfUpdateError(
      reason,
      `The ${expected.source.label} update manifest ${detail}. Nothing was installed.`,
      { retryable: false }
    )
  }
  if (manifest.source !== expected.source.id) {
    refuse('source-mismatch', `belongs to source "${manifest.source}", not ${expected.source.id}`)
  }
  if (manifest.arch !== expected.arch) {
    refuse('arch-mismatch', `is for ${manifest.arch}, and this Mac runs ${expected.arch}`)
  }
  if (manifest.bundleId !== expected.bundleId) {
    refuse('bundle-id-mismatch', `names bundle "${manifest.bundleId}", not ${expected.bundleId}`)
  }
  if (getVersionReleaseSource(manifest.version) !== expected.source.id) {
    refuse(
      'source-mismatch',
      `advertises ${manifest.version}, which is not a ${expected.source.label} version`
    )
  }
  if (expected.expectedVersion !== null) {
    if (compareAppVersions(manifest.version, expected.expectedVersion) !== 0) {
      refuse(
        'version-mismatch',
        `installs ${manifest.version}, not the requested ${expected.expectedVersion}`
      )
    }
  } else {
    const order = compareAppVersions(manifest.version, expected.currentVersion)
    if (order === 0 || (order < 0 && !expected.allowDowngrade)) {
      refuse(
        'version-not-newer',
        `advertises ${manifest.version}, which is not newer than ${expected.currentVersion}`
      )
    }
  }
  if (
    manifest.designatedRequirementSha256 !==
    expected.runningDesignatedRequirementSha256.toLowerCase()
  ) {
    refuse(
      'signing-identity-mismatch',
      'describes a bundle signed with a different identity than the running app'
    )
  }
  return manifest
}
