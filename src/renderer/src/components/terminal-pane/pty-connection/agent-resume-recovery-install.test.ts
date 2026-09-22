import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentResumeCandidate } from '../../../../../shared/agent-resume-candidate'
import { getAgentResumePaneHandler } from '@/lib/agent-resume-pane-handlers'
import { getPendingAgentResumeChoices } from '@/lib/pending-agent-resume-choices'
import { resetAgentResumeSessionReservations } from '@/lib/agent-resume-session-reservations'
import { installAgentResumeRecovery } from './agent-resume-recovery-install'
import { installPanePtyVisibilityBind } from './pane-pty-visibility-bind'
import type { ConnectPanePtySession } from './connect-pane-pty-session'

const storeState = { agentStatusByPaneKey: {}, settings: {} }

vi.mock('@/store', () => ({ useAppStore: { getState: () => storeState } }))
vi.mock('@/runtime/sync-runtime-graph', () => ({ scheduleRuntimeGraphSync: vi.fn() }))
vi.mock('@/lib/codex-stale-pane-sweep', () => ({ notifyCodexPaneBoundForStaleSweep: vi.fn() }))
vi.mock('@/lib/agent-resume-launch-target', () => ({
  resolveAgentResumeLaunchTarget: () => ({ platform: 'linux' })
}))
vi.mock('./candidate-resume-startup', () => ({
  buildCandidateResumeStartup: () => ({ agent: 'claude' })
}))

const fetchCandidates = vi.fn<() => Promise<AgentResumeCandidate[]>>()
vi.mock('@/lib/agent-resume-candidate-source', () => ({
  fetchAgentResumeCandidates: () => fetchCandidates()
}))

function makeCandidate(overrides: Partial<AgentResumeCandidate> = {}): AgentResumeCandidate {
  return {
    agent: 'claude',
    providerSession: { key: 'session_id', id: 'a521d69e-9181-481c-ab8e-998a1881b731' },
    cwd: '/w',
    title: 'Round 6',
    updatedAt: 1_789_000_000_000,
    messageCount: 758,
    branch: null,
    executionHostId: null,
    ...overrides
  }
}

/** The installers read a session bag, so the fixture supplies exactly the fields they touch. */
function buildSession(
  paneKey: string,
  overrides: Record<string, unknown> = {}
): ConnectPanePtySession {
  const transport = { getPtyId: () => null, getConnectionId: () => null }
  const paneTransports = new Map<number, unknown>([[1, transport]])
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: ConnectPanePtySession is an index-signature bag whose pane/manager fields the installers under test never dereference; this fixture supplies every field they do read.
  const session = {
    pane: { id: 1, leafId: paneKey },
    manager: {},
    deps: {
      tabId: 'tab-1',
      worktreeId: 'wt-1',
      isVisibleRef: { current: true },
      paneTransportsRef: { current: paneTransports }
    },
    transport,
    cacheKey: paneKey,
    disposed: false,
    worktree: { path: '/w' },
    executionHostId: null,
    spawnedFreshPtyId: 'pty-1',
    lastTerminalInputAt: Number.NaN,
    resolveExpectedLaunchTuiAgent: () => 'claude',
    getSleepingRecordForPane: () => null,
    startFreshColdRestoreAgentResume: vi.fn(),
    ...overrides
  } as unknown as ConnectPanePtySession
  installAgentResumeRecovery(session)
  return session
}

beforeEach(() => {
  vi.clearAllMocks()
  resetAgentResumeSessionReservations()
  storeState.agentStatusByPaneKey = {}
  fetchCandidates.mockResolvedValue([makeCandidate()])
})

describe('recovery triggers', () => {
  // The primary scenario: Orca opens with the tab already active, so the pane is visible on
  // mount and never transitions hidden -> visible.
  it('runs for a pane that is already visible when its shell spawns', async () => {
    const session = buildSession('tab-1:leaf-visible', { spawnedFreshPtyId: null })
    installPanePtyVisibilityBind(session)
    session.claimCapturedDirectSshRetryPty = () => true
    session.bindActivePanePty = (ptyId: string) => {
      session.spawnedFreshPtyId = ptyId
      return true
    }

    await session.onPtySpawn('pty-1')
    await vi.waitFor(() => expect(session.startFreshColdRestoreAgentResume).toHaveBeenCalledOnce())
  })

  it('does not run twice when the pane is later revealed', async () => {
    const session = buildSession('tab-1:leaf-latch')
    await session.attemptAgentResumeRecovery()
    await session.attemptAgentResumeRecovery()
    expect(fetchCandidates).toHaveBeenCalledOnce()
  })

  // Without positive evidence, a plain shell revealed once would be destructively replaced by
  // an unrelated conversation that merely shares the workspace.
  it('never runs for a pane with no evidence it hosted an agent', async () => {
    const session = buildSession('tab-1:leaf-plain', {
      resolveExpectedLaunchTuiAgent: () => null
    })
    await session.attemptAgentResumeRecovery()
    expect(fetchCandidates).not.toHaveBeenCalled()
    expect(session.startFreshColdRestoreAgentResume).not.toHaveBeenCalled()
  })

  it('leaves a reattached PTY alone', async () => {
    const session = buildSession('tab-1:leaf-reattached', { spawnedFreshPtyId: null })
    await session.attemptAgentResumeRecovery()
    expect(fetchCandidates).not.toHaveBeenCalled()
  })

  // EP-ERRORS: a relay that never answered is not evidence about this pane.
  it('retries after a failed attempt instead of disabling recovery', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const session = buildSession('tab-1:leaf-retry')
    fetchCandidates.mockRejectedValueOnce(new Error('relay down'))

    await session.attemptAgentResumeRecovery()
    expect(session.agentResumeRecoveryAttempted).toBe(false)
    expect(warn).toHaveBeenCalled()

    await session.attemptAgentResumeRecovery()
    expect(session.startFreshColdRestoreAgentResume).toHaveBeenCalledOnce()
    warn.mockRestore()
  })
})

describe('concurrent panes on one transcript', () => {
  // Both scans resolve the same sole candidate before either spawn reports a status, so only
  // the synchronous reservation can keep them apart.
  it('lets exactly one of two panes revealed together resume the session', async () => {
    const first = buildSession('tab-1:leaf-a')
    const second = buildSession('tab-1:leaf-b')

    await Promise.all([first.attemptAgentResumeRecovery(), second.attemptAgentResumeRecovery()])

    const resumed = [first, second].filter(
      (session) => session.startFreshColdRestoreAgentResume.mock.calls.length > 0
    )
    expect(resumed).toHaveLength(1)
  })
})

describe('a choice that settles after the pane is gone', () => {
  it('is never offered once the pane was disposed', async () => {
    const session = buildSession('tab-1:leaf-disposed')
    fetchCandidates.mockImplementation(async () => {
      session.disposed = true
      return [
        makeCandidate(),
        makeCandidate({
          providerSession: { key: 'session_id', id: 'b171319f-6711-4537-89be-00f26ccc7e32' },
          updatedAt: 1_788_000_000_000
        })
      ]
    })

    await session.attemptAgentResumeRecovery()
    expect(getPendingAgentResumeChoices('tab-1:leaf-disposed')).toBeUndefined()
  })

  it('is never offered once a successor owns the pane', async () => {
    const session = buildSession('tab-1:leaf-successor')
    fetchCandidates.mockImplementation(async () => {
      // A successor connection claimed this pane's slot while the scan was in flight.
      session.deps.paneTransportsRef.current.delete(1)
      return [
        makeCandidate(),
        makeCandidate({
          providerSession: { key: 'session_id', id: 'b171319f-6711-4537-89be-00f26ccc7e32' },
          updatedAt: 1_788_000_000_000
        })
      ]
    })

    await session.attemptAgentResumeRecovery()
    expect(getPendingAgentResumeChoices('tab-1:leaf-successor')).toBeUndefined()
    expect(getAgentResumePaneHandler('tab-1:leaf-successor')).toBeDefined()
  })
})
