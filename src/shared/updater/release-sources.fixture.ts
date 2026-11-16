/**
 * Test-only: stands in for the `ORCA_RELEASE_SOURCES` compile-time define, which
 * tests cannot set. The registry reads it from `globalThis` when the define is
 * absent; callers re-import the module after switching it.
 */

export const FORK_RELEASE_SOURCES_LITERAL = JSON.stringify([
  { id: 'upstream', label: 'Orca upstream', repo: 'stablyai/orca', prereleaseIdentifier: null },
  { id: 'swaplabs', label: 'SwapLabs', repo: 'SwapLabsInc/orca', prereleaseIdentifier: 'swaplabs' }
])

export function setReleaseSourcesLiteralForTest(literal: string | null): void {
  if (literal === null) {
    Reflect.deleteProperty(globalThis, 'ORCA_RELEASE_SOURCES')
    return
  }
  Object.defineProperty(globalThis, 'ORCA_RELEASE_SOURCES', {
    value: literal,
    configurable: true,
    enumerable: true,
    writable: true
  })
}
