import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { setReleaseSourcesLiteralForTest } from '../../../shared/release-sources.fixture'
import type { ReleaseSource } from '../../../shared/release-sources'
import { MacSelfUpdateError } from './mac-self-update-failure'
import {
  createMacSelfUpdatePublicKey,
  verifyMacSelfUpdateManifest,
  type MacSelfUpdateExpectation
} from './mac-self-update-manifest'

// Why hoisted: the source registry reads its define once, when the first import loads it.
vi.hoisted(async () => {
  const fixture = await import('../../../shared/release-sources.fixture')
  fixture.setReleaseSourcesLiteralForTest(fixture.FORK_RELEASE_SOURCES_LITERAL)
})

const SWAPLABS: ReleaseSource = {
  id: 'swaplabs',
  label: 'SwapLabs',
  repo: 'SwapLabsInc/orca',
  prereleaseIdentifier: 'swaplabs'
}
const DR_SHA256 = 'a'.repeat(64)
const SHA512 = `${'A'.repeat(86)}==`

function rawPublicKeyBase64(publicKey: KeyObject): string {
  // The last 32 bytes of the SPKI DER are the raw Ed25519 key.
  const der = publicKey.export({ type: 'spki', format: 'der' })
  return der.subarray(-32).toString('base64')
}

function manifestBytes(overrides: Record<string, unknown> = {}): Buffer {
  return Buffer.from(
    JSON.stringify({
      schema: 1,
      source: 'swaplabs',
      version: '1.4.197-swaplabs.202609251200',
      arch: 'arm64',
      file: 'orca-macos-arm64.zip',
      size: 123456,
      sha512: SHA512,
      bundleId: 'com.stablyai.orca',
      commit: 'abcdef123456',
      designatedRequirementSha256: DR_SHA256,
      releasedAt: '2026-09-25T12:00:00Z',
      ...overrides
    }),
    'utf8'
  )
}

describe('mac self-update manifest verification', () => {
  let signingKey: KeyObject
  let publicKey: KeyObject
  let expectation: MacSelfUpdateExpectation

  const signed = (bytes: Buffer, key: KeyObject = signingKey): string =>
    sign(null, bytes, key).toString('base64')
  const verify = (bytes: Buffer, signature: string, expected = expectation) =>
    verifyMacSelfUpdateManifest(bytes, signature, publicKey, expected)
  const reasonOf = (run: () => unknown): string => {
    try {
      run()
    } catch (error) {
      if (error instanceof MacSelfUpdateError) {
        return error.reason
      }
      throw error
    }
    throw new Error('expected a refusal')
  }

  beforeEach(() => {
    const pair = generateKeyPairSync('ed25519')
    signingKey = pair.privateKey
    publicKey = createMacSelfUpdatePublicKey(rawPublicKeyBase64(pair.publicKey))
    expectation = {
      source: SWAPLABS,
      arch: 'arm64',
      bundleId: 'com.stablyai.orca',
      currentVersion: '1.4.197-swaplabs.202609241530',
      expectedVersion: null,
      allowDowngrade: false,
      runningDesignatedRequirementSha256: DR_SHA256
    }
  })

  afterAll(() => {
    setReleaseSourcesLiteralForTest(null)
  })

  it('accepts a correctly signed manifest for a newer build of the running source', () => {
    const bytes = manifestBytes()
    const manifest = verify(bytes, signed(bytes))
    expect(manifest.version).toBe('1.4.197-swaplabs.202609251200')
    expect(manifest.file).toBe('orca-macos-arm64.zip')
    expect(manifest.designatedRequirementSha256).toBe(DR_SHA256)
  })

  it('refuses a manifest whose bytes changed after signing, before reading any field', () => {
    const bytes = manifestBytes()
    const signature = signed(bytes)
    const tampered = Buffer.from(bytes.toString('utf8').replace('123456', '123457'), 'utf8')
    expect(reasonOf(() => verify(tampered, signature))).toBe('signature-invalid')
    // Not even a malformed body is parsed without a valid signature.
    expect(reasonOf(() => verify(Buffer.from('not json'), signature))).toBe('signature-invalid')
  })

  it('refuses a manifest signed with another key, an empty or truncated signature', () => {
    const bytes = manifestBytes()
    const otherKey = generateKeyPairSync('ed25519').privateKey
    expect(reasonOf(() => verify(bytes, signed(bytes, otherKey)))).toBe('signature-invalid')
    expect(reasonOf(() => verify(bytes, ''))).toBe('signature-invalid')
    expect(reasonOf(() => verify(bytes, signed(bytes).slice(0, 40)))).toBe('signature-invalid')
  })

  it.each([
    ['source', { source: 'upstream' }, 'source-mismatch'],
    ['arch', { arch: 'x64', file: 'orca-macos-x64.zip' }, 'arch-mismatch'],
    ['bundle id', { bundleId: 'com.example.other' }, 'bundle-id-mismatch'],
    ['version of another source', { version: '1.4.198' }, 'source-mismatch'],
    [
      'signing identity',
      { designatedRequirementSha256: 'b'.repeat(64) },
      'signing-identity-mismatch'
    ]
  ])("refuses a signed manifest whose %s is not this build's", (_label, overrides, reason) => {
    const bytes = manifestBytes(overrides)
    expect(reasonOf(() => verify(bytes, signed(bytes)))).toBe(reason)
  })

  it('refuses a downgrade or the same version on a routine check, but takes a pinned downgrade', () => {
    const older = manifestBytes({ version: '1.4.197-swaplabs.202609231000' })
    expect(reasonOf(() => verify(older, signed(older)))).toBe('version-not-newer')
    const same = manifestBytes({ version: expectation.currentVersion })
    expect(reasonOf(() => verify(same, signed(same)))).toBe('version-not-newer')
    expect(
      verify(older, signed(older), {
        ...expectation,
        allowDowngrade: true,
        expectedVersion: '1.4.197-swaplabs.202609231000'
      }).version
    ).toBe('1.4.197-swaplabs.202609231000')
  })

  it('requires a pinned check to get exactly the version it asked for', () => {
    const bytes = manifestBytes()
    const pinned = { ...expectation, expectedVersion: '1.4.197-swaplabs.202609251201' }
    expect(reasonOf(() => verify(bytes, signed(bytes), pinned))).toBe('version-mismatch')
  })

  it.each([
    ['schema', { schema: 2 }],
    ['zip name', { file: 'Orca.app.zip' }],
    ['size', { size: -1 }],
    ['size type', { size: '10' }],
    ['sha512', { sha512: 'nope' }],
    ['commit', { commit: 'main' }],
    ['designated requirement hash', { designatedRequirementSha256: 'xyz' }],
    ['timestamp', { releasedAt: 'yesterday' }],
    ['version', { version: 'latest' }]
  ])('refuses a signed manifest with a malformed %s', (_label, overrides) => {
    const bytes = manifestBytes(overrides)
    expect(reasonOf(() => verify(bytes, signed(bytes)))).toBe('manifest-malformed')
  })

  it('rejects a public key that is not 32 raw bytes', () => {
    expect(() => createMacSelfUpdatePublicKey('AAAA')).toThrow(MacSelfUpdateError)
  })
})
