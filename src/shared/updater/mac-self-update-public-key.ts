/**
 * LOCAL: the Ed25519 public key a SwapLabs macOS build verifies its update
 * manifests with, compiled in as the `ORCA_SWAPLABS_UPDATE_PUBLIC_KEY` define
 * (the raw 32-byte key, base64). Upstream, contributor and test builds carry
 * `null`, which keeps Orca's own macOS installer off and the Mac assets
 * download-only. Only the main process reads it; the renderer never needs it.
 */

/** Base64 of exactly 32 bytes: 43 significant characters and one pad. */
const RAW_ED25519_PUBLIC_KEY_BASE64 = /^[A-Za-z0-9+/]{43}=$/

export class MacSelfUpdatePublicKeyError extends Error {
  constructor(message: string) {
    super(`ORCA_SWAPLABS_UPDATE_PUBLIC_KEY: ${message}`)
    this.name = 'MacSelfUpdatePublicKeyError'
  }
}

/**
 * Validates the build-time literal and returns it trimmed. Throws so a
 * misconfigured pipeline variable fails the build rather than shipping an app
 * whose installer rejects every manifest.
 */
export function parseMacSelfUpdatePublicKey(literal: string): string {
  const key = literal.trim()
  if (key.length === 0) {
    throw new MacSelfUpdatePublicKeyError('must not be empty')
  }
  if (!RAW_ED25519_PUBLIC_KEY_BASE64.test(key)) {
    throw new MacSelfUpdatePublicKeyError(
      'must be the raw 32-byte Ed25519 public key in base64 (44 characters)'
    )
  }
  return key
}

declare global {
  /** Compile-time define from `electron.vite.config.ts`; absent in dev and tests. */
  const ORCA_SWAPLABS_UPDATE_PUBLIC_KEY: string | null
}

/** The compiled-in key, or null when this build has none. Tests stand it in on `globalThis`. */
export function readMacSelfUpdatePublicKey(): string | null {
  const literal =
    typeof ORCA_SWAPLABS_UPDATE_PUBLIC_KEY !== 'undefined'
      ? ORCA_SWAPLABS_UPDATE_PUBLIC_KEY
      : Object.getOwnPropertyDescriptor(globalThis, 'ORCA_SWAPLABS_UPDATE_PUBLIC_KEY')?.value
  if (typeof literal !== 'string' || literal.length === 0) {
    return null
  }
  try {
    return parseMacSelfUpdatePublicKey(literal)
  } catch (error) {
    // Why: the build validated this literal, so a failure here is tampering or a packaging bug;
    // a build with no key stays download-only, which is the safe side.
    console.error(
      '[mac-self-update] ignoring invalid ORCA_SWAPLABS_UPDATE_PUBLIC_KEY define:',
      error
    )
    return null
  }
}
