import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { pruneDesktopOrcadArtifactCache } from './orcad-artifact-cache-retention'

const SLOT_CLOCK_MS = Date.UTC(2026, 0, 1)

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

function cacheRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'orcad-artifact-cache-'))
  roots.push(root)
  return root
}

/** A real slot version name; `n` distinguishes builds. */
function version(n: number): string {
  return `0.1.0+${n.toString(16).padStart(12, '0')}`
}

function slot(root: string, target: string, name: string, ageMinutes: number): string {
  const path = join(root, target, name)
  mkdirSync(path, { recursive: true })
  writeFileSync(join(path, 'orcad.js'), '')
  const at = new Date(SLOT_CLOCK_MS - ageMinutes * 60_000)
  utimesSync(path, at, at)
  return path
}

describe('orcad artifact cache retention for a drained terminal daemon', () => {
  it('keeps the slot a drained terminal daemon still runs from', async () => {
    const userData = cacheRoot()
    const root = join(userData, 'orcad-artifacts')
    const drainedSlot = slot(root, 'linux-x64-glibc', version(90), 90)
    const others = [1, 2, 3, 4].map((age) => slot(root, 'linux-x64-glibc', version(age), age))
    mkdirSync(join(userData, 'daemon'))
    writeFileSync(
      join(userData, 'daemon', 'drain-v30-0123abcd.pid'),
      JSON.stringify({ pid: process.pid, entryPath: join(drainedSlot, 'out', 'daemon-entry.js') })
    )
    expect((await pruneDesktopOrcadArtifactCache(userData)).sort()).toEqual(
      [others[2], others[3]].sort()
    )
    expect(existsSync(drainedSlot)).toBe(true)
  })
})
