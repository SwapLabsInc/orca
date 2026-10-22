import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('mac self-update launch wiring', () => {
  // LOCAL: the self-update helper keeps whatever build writes the health marker, so only a
  // window that can paint may write it: never a fallback timer, and never a headless serve.
  it('signals self-update health from the first window alone, and not under headless serve', () => {
    const runtimeSource = readFileSync(
      join(process.cwd(), 'src/main/startup/main-process-ready-runtime.ts'),
      'utf8'
    )
    const SIGNAL = 'reportMacSelfUpdateLaunchOutcome()'
    expect(runtimeSource.split(SIGNAL).length - 1).toBe(1)
    const guard = runtimeSource.indexOf('if (!state.isServeMode) {')
    const scheduled = runtimeSource.indexOf('runOnlyAfterFirstWindowShown(() => {', guard)
    const signal = runtimeSource.indexOf(SIGNAL, scheduled)
    expect(guard).toBeGreaterThanOrEqual(0)
    expect(scheduled).toBeGreaterThan(guard)
    expect(signal).toBeGreaterThan(scheduled)
    expect(signal - guard).toBeLessThan(200)
    // No fallback timer anywhere near it: `runAfterFirstWindowShown(` takes one.
    expect(runtimeSource.slice(guard, signal)).not.toContain('runAfterFirstWindowShown(')

    const serveSource = readFileSync(
      join(process.cwd(), 'src/main/startup/main-process-serve.ts'),
      'utf8'
    )
    expect(serveSource).not.toContain('reportMacSelfUpdateLaunchOutcome')
  })
})
