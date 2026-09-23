import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentResumeCandidate } from '../../../../../shared/agent-resume-candidate'
import { getAgentResumePaneHandler } from '@/lib/agent-resume-pane-handlers'
import { getPendingAgentResumeChoices } from '@/lib/pending-agent-resume-choices'
import { resetAgentResumeSessionReservations } from '@/lib/agent-resume-session-reservations'
import type { AgentResumeCandidateScan } from '@/lib/agent-resume-candidate-source'
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

const fetchCandidates = vi.fn<() => Promise<AgentResumeCandidateScan>>()
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

/** Two survivors nothing separates, so the resolver asks rather than resuming. */
function twoCandidates(): AgentResumeCandidate[] {
  return [
    makeCandidate(),
    makeCandidate({
      providerSession: { key: 'session_id', id: 'b171319f-6711-4537-89be-00f26ccc7e32' },
      updatedAt: 1_788_000_000_000
    })
  ]
}

/** The installers read a session bag, so the fixture supplies exactly the fields they touch. */
function buildSession(
  paneKey: string,
  overrides: Record<string, unknown> = {},
  sharedPaneTransports?: Map<number, unknown>
): ConnectPanePtySession {
  const transport = { getPtyId: () => null, getConnectionId: () => null }
  const paneTransports = sharedPaneTransports ?? new Map<number, unknown>()
  // The successor of a replaced binding: registering it retires whichever binding held the slot.
  paneTransports.set(1, transport)
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
    // The tab-wide value the guard must NOT read; the pane-scoped one is what authorizes a resume.
    resolveExpectedLaunchTuiAgent: () => 'claude',
    resolvePaneScopedTuiAgent: () => 'claude',
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
  fetchCandidates.mockResolvedValue({ kind: 'complete', candidates: [makeCandidate()] })
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

  // The second half of the same question: a pane whose pty is replaced while its tab stays
  // active gets a new binding, and that binding — not the retired one — runs recovery.
  it('runs for a replacement binding and never for the binding it retired', async () => {
    const paneTransports = new Map<number, unknown>()
    const retired = buildSession('tab-1:leaf-replaced', {}, paneTransports)
    const successor = buildSession('tab-1:leaf-replaced', {}, paneTransports)

    await retired.attemptAgentResumeRecovery()
    expect(fetchCandidates).not.toHaveBeenCalled()

    await successor.attemptAgentResumeRecovery()
    expect(successor.startFreshColdRestoreAgentResume).toHaveBeenCalledOnce()
    expect(retired.startFreshColdRestoreAgentResume).not.toHaveBeenCalled()
  })

  // C: `resolveExpectedLaunchTuiAgent` reads the tab-wide launchAgent, which describes the tab's
  // ORIGINAL pty. A plain-shell split beside an agent pane must not inherit that evidence and
  // have its shell replaced by a historical conversation.
  it('never runs on tab-wide launch evidence alone', async () => {
    const session = buildSession('tab-1:leaf-split', { resolvePaneScopedTuiAgent: () => null })
    await session.attemptAgentResumeRecovery()
    expect(fetchCandidates).not.toHaveBeenCalled()
    expect(session.startFreshColdRestoreAgentResume).not.toHaveBeenCalled()
  })

  // D: a cancelled or partial scan answered about nothing, so it must not burn the one attempt
  // this connection gets.
  it('does not spend the attempt on an unverifiable scan', async () => {
    const session = buildSession('tab-1:leaf-partial')
    fetchCandidates.mockResolvedValueOnce({ kind: 'unverifiable', reason: 'scan-issues' })

    await session.attemptAgentResumeRecovery()
    expect(session.agentResumeRecoveryAttempted).toBe(false)
    expect(session.startFreshColdRestoreAgentResume).not.toHaveBeenCalled()

    await session.attemptAgentResumeRecovery()
    expect(session.startFreshColdRestoreAgentResume).toHaveBeenCalledOnce()
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
      resolveExpectedLaunchTuiAgent: () => null,
      resolvePaneScopedTuiAgent: () => null
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
      return { kind: 'complete', candidates: twoCandidates() }
    })

    await session.attemptAgentResumeRecovery()
    expect(getPendingAgentResumeChoices('tab-1:leaf-disposed')).toBeUndefined()
  })

  it('is never offered once a successor owns the pane', async () => {
    const session = buildSession('tab-1:leaf-successor')
    fetchCandidates.mockImplementation(async () => {
      // A successor connection claimed this pane's slot while the scan was in flight.
      session.deps.paneTransportsRef.current.delete(1)
      return { kind: 'complete', candidates: twoCandidates() }
    })

    await session.attemptAgentResumeRecovery()
    expect(getPendingAgentResumeChoices('tab-1:leaf-successor')).toBeUndefined()
    expect(getAgentResumePaneHandler('tab-1:leaf-successor', session.transport)).toBeDefined()
  })
})

describe('revalidating a claim at chooser selection', () => {
  // The chooser's rows were scanned seconds ago, and the renderer-local reservation map is not the
  // only way a candidate goes live: another pane's cold restore and an Agent Session History
  // launch both reserve nothing here, so the host-owned status store is the evidence.
  it('refuses a candidate that went live after the chooser was populated', async () => {
    const session = buildSession('tab-1:leaf-revalidate')
    const candidate = makeCandidate()
    storeState.agentStatusByPaneKey = {
      'tab-9:leaf-other': { providerSession: candidate.providerSession, state: 'working' }
    }

    const handler = getAgentResumePaneHandler('tab-1:leaf-revalidate', session.transport)
    expect(handler?.(candidate)).toBe(false)
    expect(session.startFreshColdRestoreAgentResume).not.toHaveBeenCalled()
  })

  it('still resumes a candidate whose only live row is a finished pane', async () => {
    const session = buildSession('tab-1:leaf-revalidate-done')
    const candidate = makeCandidate()
    storeState.agentStatusByPaneKey = {
      'tab-9:leaf-other': { providerSession: candidate.providerSession, state: 'done' }
    }

    const handler = getAgentResumePaneHandler('tab-1:leaf-revalidate-done', session.transport)
    expect(handler?.(candidate)).toBe(true)
  })
})

describe('a choice published by a retired binding', () => {
  // Pending choices carried no binding identity, so a stale chooser reached the SUCCESSOR's
  // handler and could replace its shell with a candidate scanned for the retired connection.
  it('cannot reach the successor handler that replaced its owner', async () => {
    const paneTransports = new Map<number, unknown>()
    const retired = buildSession('tab-1:leaf-stale-choice', {}, paneTransports)
    fetchCandidates.mockResolvedValueOnce({ kind: 'complete', candidates: twoCandidates() })
    await retired.attemptAgentResumeRecovery()

    const choice = getPendingAgentResumeChoices('tab-1:leaf-stale-choice')
    expect(choice?.owner).toBe(retired.transport)

    const successor = buildSession('tab-1:leaf-stale-choice', {}, paneTransports)
    expect(getAgentResumePaneHandler('tab-1:leaf-stale-choice', choice!.owner)).toBeUndefined()
    expect(getAgentResumePaneHandler('tab-1:leaf-stale-choice', successor.transport)).toBeDefined()
  })
})

describe('visibility lost mid-scan', () => {
  // The contract is that a hidden pane does not spend its attempt and retries when revealed. The
  // post-scan gate answers `pane-hidden` too, and it was spending the latch.
  it('does not spend the attempt when the pane is hidden during the scan', async () => {
    const session = buildSession('tab-1:leaf-hidden-midscan')
    fetchCandidates.mockImplementationOnce(async () => {
      session.deps.isVisibleRef.current = false
      return { kind: 'complete', candidates: [makeCandidate()] }
    })

    await session.attemptAgentResumeRecovery()
    expect(session.agentResumeRecoveryAttempted).toBe(false)
    expect(session.startFreshColdRestoreAgentResume).not.toHaveBeenCalled()

    session.deps.isVisibleRef.current = true
    await session.attemptAgentResumeRecovery()
    expect(session.startFreshColdRestoreAgentResume).toHaveBeenCalledOnce()
  })
})

describe('folder workspaces', () => {
  // AGENTS.md: a folder workspace is as valid as a git worktree and keeps its root on
  // `folderWorkspace.folderPath`, so gating on `worktree.path` made those panes unrecoverable.
  it('recovers a pane whose workspace is a folder, not a worktree', async () => {
    const session = buildSession('tab-1:leaf-folder', {
      worktree: undefined,
      // Same path the fixture candidate names, so only the scope derivation is under test.
      folderWorkspace: { projectGroupId: 'pg-1', folderPath: '/w' }
    })
    await session.attemptAgentResumeRecovery()
    expect(session.startFreshColdRestoreAgentResume).toHaveBeenCalledOnce()
  })

  it('still refuses a pane with neither representation', async () => {
    const session = buildSession('tab-1:leaf-no-scope', {
      worktree: undefined,
      folderWorkspace: undefined
    })
    await session.attemptAgentResumeRecovery()
    expect(fetchCandidates).not.toHaveBeenCalled()
  })
})
