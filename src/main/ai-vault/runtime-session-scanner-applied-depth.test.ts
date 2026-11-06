import { beforeEach, expect, it, vi } from 'vitest'
import type {
  AiVaultListResult,
  AiVaultSession
} from '../../shared/ai-vault/contracts/ai-vault-types'

const mocks = vi.hoisted(() => ({
  callRuntimeEnvironment: vi.fn(),
  resolveEnvironment: vi.fn()
}))

vi.mock('../../shared/remote-runtime/host-store/runtime-environment-store', () => ({
  listEnvironments: () => [],
  resolveEnvironment: mocks.resolveEnvironment
}))

vi.mock('../ipc/runtime-environments/runtime-environment-transport-routing', () => ({
  callRuntimeEnvironment: mocks.callRuntimeEnvironment
}))

const { scanRuntimeAiVaultSessions } = await import('./runtime-session-scanner')

beforeEach(() => {
  vi.clearAllMocks()
  mocks.resolveEnvironment.mockImplementation(() => {
    throw new Error('not saved')
  })
})

it('keeps the scan depth the host applied, so coverage is not read as truncated', async () => {
  const listed: AiVaultListResult = {
    sessions: [session('local', 'session-1')],
    issues: [],
    scannedAt: '2026-07-04T00:00:00.000Z',
    appliedSessionDepth: 'unlimited'
  }
  mocks.callRuntimeEnvironment.mockResolvedValueOnce({ ok: true, result: listed })

  const scanResult = await scanRuntimeAiVaultSessions('/user-data', 'env-1', {})

  // Retagging owns host identity only. Dropping this field reads downstream as a truncated
  // scan, which refuses recovery on every runtime host.
  expect(scanResult.appliedSessionDepth).toBe('unlimited')
})

function session(
  executionHostId: AiVaultSession['executionHostId'],
  sessionId: string
): AiVaultSession {
  return {
    id: `${executionHostId}:codex:${sessionId}:/sessions/${sessionId}.jsonl`,
    executionHostId,
    executionHostPlatform: 'linux',
    agent: 'codex',
    sessionId,
    title: sessionId,
    cwd: '/srv/app',
    branch: null,
    model: null,
    filePath: `/sessions/${sessionId}.jsonl`,
    codexHome: null,
    createdAt: null,
    updatedAt: '2026-07-04T03:00:00.000Z',
    modifiedAt: '2026-07-04T00:00:00.000Z',
    messageCount: 1,
    totalTokens: 0,
    previewMessages: [],
    queuedMessageCount: 0,
    subagentTranscriptCount: 0,
    resumeCommand: `codex resume ${sessionId}`,
    subagent: null
  }
}
