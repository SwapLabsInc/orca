import { afterEach, expect, it, vi } from 'vitest'

const { scanAiVaultSessionsInBackground } = vi.hoisted(() => ({
  scanAiVaultSessionsInBackground: vi.fn()
}))

vi.mock('../scan-service/session-scanner-background', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  scanAiVaultSessionsInBackground
}))
vi.mock('../discovery/ai-vault-scan-roots', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  resolveLocalAiVaultScanRoots: vi.fn(async () => ({
    roots: { additionalCodexSessionsDirs: [], wslHomeDirs: [] },
    wslConfirmed: true
  }))
}))

import { listAiVaultSessions, resetAiVaultSessionListCacheForTests } from './cached-session-list'

afterEach(() => {
  resetAiVaultSessionListCacheForTests()
  scanAiVaultSessionsInBackground.mockReset()
})

// LOCAL: resume refuses a scan that cannot say how deep it looked, so the local leg has to say.
it.each([
  ['a capped scan', { limit: 25 }, 25],
  ['an uncapped scan', { unlimited: true }, 'unlimited']
] as const)('echoes the depth %s ran under', async (_name, depthArgs, applied) => {
  scanAiVaultSessionsInBackground.mockResolvedValue({ sessions: [], issues: [], scannedAt: 's1' })

  const result = await listAiVaultSessions({ scopePaths: ['/src/r1'], ...depthArgs })

  expect(result.appliedSessionDepth).toBe(applied)
})
