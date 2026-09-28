/**
 * Test-only: stands in for the `ORCA_SWAPLABS_UPDATE_PUBLIC_KEY` compile-time
 * define, which tests cannot set. The reader falls back to `globalThis`.
 */
export function setMacSelfUpdatePublicKeyForTest(literal: string | null): void {
  if (literal === null) {
    Reflect.deleteProperty(globalThis, 'ORCA_SWAPLABS_UPDATE_PUBLIC_KEY')
    return
  }
  Object.defineProperty(globalThis, 'ORCA_SWAPLABS_UPDATE_PUBLIC_KEY', {
    value: literal,
    configurable: true,
    enumerable: true,
    writable: true
  })
}
