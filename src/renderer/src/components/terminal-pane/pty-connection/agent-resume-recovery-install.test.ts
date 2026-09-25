import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentResumeCandidate } from '../../../../../shared/agent-resume-candidate'
import { getAgentResumePaneHandler } from '@/lib/agent-resume-pane-handlers'
import { getPendingAgentResumeChoices } from '@/lib/pending-agent-resume-choices'
import { resetAgentResumeSessionReservations } from '@/lib/agent-resume-session-reservations'
import type { AgentResumeCandidateScan } from '@/lib/agent-resume-candidate-source'
import { installAgentResumeRecovery } from './agent-resume-recovery-install'
import { installPanePtyVisibilityBind } from './pane-pty-visibility-bind'
import type { ConnectPanePtySession } from './connect-pane-pty-session'

const storeState: {
  agentStatusByPaneKey: Record<string, unknown>
  terminalLayoutsByTabId: Record<string, unknown>
  settings: Record<string, unknown>
} = { agentStatusByPaneKey: {}, terminalLayoutsByTabId: {}, settings: {} }

// Real leaf UUIDs: the claim rule resolves a row's pane from its key, and `parsePaneKey` rejects
// anything else. Only the liveness-sensitive cases below need them.
const OWN_LEAF = 'c6d5f4aa-2f0e-4a31-9c1e-1d6f1a0b2c30'
const SIBLING_LEAF = 'd7e6a5bb-3f1f-4b42-8d2f-2e7f2b1c3d41'
const OWN_PANE_KEY = `tab-1:${OWN_LEAF}`
const SIBLING_PANE_KEY = `tab-9:${SIBLING_LEAF}`

function bindLayout(tabId: string, leafId: string, ptyId: string | undefined): void {
  storeState.terminalLayoutsByTabId[tabId] = { ptyIdsByLeafId: { [leafId]: ptyId } }
}

const storeSubscribers: (() => void)[] = []
vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => storeState,
    subscribe: (listener: () => void) => {
      storeSubscribers.push(listener)
      return () => {
        const at = storeSubscribers.indexOf(listener)
        if (at !== -1) {
          storeSubscribers.splice(at, 1)
        }
      }
    }
  }
}))
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
    executionHostPlatform: null,
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
  const transport = { getPtyId: () => null, getConnectionId: () => null, disconnect: vi.fn() }
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
      paneTransportsRef: { current: paneTransports },
      clearTabPtyId: vi.fn()
    },
    transport,
    cacheKey: paneKey,
    disposed: false,
    worktree: { path: '/w' },
    executionHostId: null,
    executionHostPlatform: null,
    spawnedFreshPtyId: 'pty-1',
    lastTerminalInputAt: Number.NaN,
    lastRealUserInputAt: Number.NaN,
    // xterm's provenance signal is available; `null` is the fallback the gate must read conservatively.
    userInputActivityDisposable: { dispose: vi.fn() },
    // The tab-wide value the guard must NOT read; the pane-scoped one is what authorizes a resume.
    resolveExpectedLaunchTuiAgent: () => 'claude',
    resolvePaneScopedTuiAgent: () => 'claude',
    getSleepingRecordForPane: () => null,
    startFreshColdRestoreAgentResume: vi.fn(),
    clearExitedPanePtyLayoutBinding: vi.fn(),
    syncPanePtyLayoutBinding: vi.fn(),
    ...overrides
  } as unknown as ConnectPanePtySession
  installAgentResumeRecovery(session)
  return session
}

beforeEach(() => {
  vi.clearAllMocks()
  resetAgentResumeSessionReservations()
  storeState.agentStatusByPaneKey = {}
  storeState.terminalLayoutsByTabId = {}
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

  it('retries once pane-scoped agent status hydrates, with no visibility flip', async () => {
    // The hook server's persisted snapshot can land after onPtySpawn already ran the gate. An
    // already-visible pane gets no later reveal, so without this the pane stays a plain shell.
    let paneAgent: string | null = null
    const session = buildSession('tab-1:leaf-late-status', {
      resolveExpectedLaunchTuiAgent: () => null,
      resolvePaneScopedTuiAgent: () => paneAgent
    })
    const before = storeSubscribers.length
    await session.attemptAgentResumeRecovery()
    expect(fetchCandidates).not.toHaveBeenCalled()
    expect(storeSubscribers.length).toBe(before + 1)

    paneAgent = 'claude'
    for (const listener of storeSubscribers.slice()) {
      listener()
    }
    await Promise.resolve()
    await Promise.resolve()

    expect(fetchCandidates).toHaveBeenCalled()
  })

  it('never recovers into a pane opened to run a specific command', async () => {
    // launchAgent here names what the user just asked to start, not a conversation that went
    // missing. Recovery begins before the startup is delivered, so a scan finishing later would
    // replace the requested agent with an older transcript.
    const session = buildSession('tab-1:leaf-deliberate', {
      paneStartup: { command: 'claude', launchAgent: 'claude' }
    })
    await session.attemptAgentResumeRecovery()
    expect(fetchCandidates).not.toHaveBeenCalled()
    expect(session.startFreshColdRestoreAgentResume).not.toHaveBeenCalled()
    // Latched: the request still stands once the command has been delivered and cleared.
    session.paneStartup = undefined
    await session.attemptAgentResumeRecovery()
    expect(fetchCandidates).not.toHaveBeenCalled()
  })

  it('retires the bound plain shell before spawning the resume', async () => {
    // The fresh shell still owns the pane's stable key, so a bare connect would reattach it and
    // the resume command would never run — success reported over an untouched shell.
    const session = buildSession('tab-1:leaf-retire')
    fetchCandidates.mockResolvedValueOnce({ kind: 'complete', candidates: [makeCandidate()] })
    await session.attemptAgentResumeRecovery()
    expect(session.transport.disconnect).toHaveBeenCalled()
    expect(session.clearExitedPanePtyLayoutBinding).toHaveBeenCalledWith('pty-1')
    expect(session.startFreshColdRestoreAgentResume).toHaveBeenCalled()
    const disconnectOrder = session.transport.disconnect.mock.invocationCallOrder[0]
    const spawnOrder = session.startFreshColdRestoreAgentResume.mock.invocationCallOrder[0]
    expect(disconnectOrder).toBeLessThan(spawnOrder)
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
    const session = buildSession(OWN_PANE_KEY)
    const candidate = makeCandidate()
    storeState.agentStatusByPaneKey = {
      [SIBLING_PANE_KEY]: { providerSession: candidate.providerSession, state: 'working' }
    }
    bindLayout('tab-9', SIBLING_LEAF, 'pty-9')

    const handler = getAgentResumePaneHandler(OWN_PANE_KEY, session.transport)
    expect(handler?.(candidate)).toBe(false)
    expect(session.startFreshColdRestoreAgentResume).not.toHaveBeenCalled()
  })

  // TOO NARROW, fixed: `done` is "task complete but pane LIVE" (agent-status.ts), so a finished
  // sibling still owns its transcript and resuming it here would run two agents on one.
  it('refuses a candidate whose only row is a done-but-live sibling pane', async () => {
    const session = buildSession(OWN_PANE_KEY)
    const candidate = makeCandidate()
    storeState.agentStatusByPaneKey = {
      [SIBLING_PANE_KEY]: { providerSession: candidate.providerSession, state: 'done' }
    }
    bindLayout('tab-9', SIBLING_LEAF, 'pty-9')

    const handler = getAgentResumePaneHandler(OWN_PANE_KEY, session.transport)
    expect(handler?.(candidate)).toBe(false)
    expect(session.startFreshColdRestoreAgentResume).not.toHaveBeenCalled()
  })

  it('resumes once the pane that held the row is gone from this renderer', async () => {
    const session = buildSession(OWN_PANE_KEY)
    const candidate = makeCandidate()
    storeState.agentStatusByPaneKey = {
      [SIBLING_PANE_KEY]: { providerSession: candidate.providerSession, state: 'done' }
    }

    const handler = getAgentResumePaneHandler(OWN_PANE_KEY, session.transport)
    expect(handler?.(candidate)).toBe(true)
  })
})

describe('the restart this feature exists for', () => {
  // TOO BROAD, fixed: the hook server republishes the recovering pane's OWN persisted row as
  // `restoredUnconfirmed` (server-hydration.ts). Counting it as a claim filtered out the sole
  // candidate, so a restart during working/blocked/waiting left a plain shell.
  it('recovers a pane whose own nonterminal row came back restoredUnconfirmed', async () => {
    const candidate = makeCandidate()
    const session = buildSession(OWN_PANE_KEY)
    storeState.agentStatusByPaneKey = {
      [OWN_PANE_KEY]: {
        providerSession: candidate.providerSession,
        state: 'working',
        restoredUnconfirmed: true
      }
    }
    bindLayout('tab-1', OWN_LEAF, 'pty-1')

    await session.attemptAgentResumeRecovery()
    expect(session.startFreshColdRestoreAgentResume).toHaveBeenCalledOnce()
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

describe('input that is not the user typing', () => {
  // The restart this feature exists for leaves the dead agent's mouse tracking armed until the
  // ground lands, so the first thing a fresh shell receives is often SGR mouse reports. Those,
  // focus reports and xterm's query replies all make `lastTerminalInputAt` finite; none of them
  // are the user claiming the shell.
  it('stays eligible after mouse and focus reports alone, and keeps the attempt unspent', async () => {
    const session = buildSession('tab-1:leaf-mouse', { lastTerminalInputAt: 12 })
    await session.attemptAgentResumeRecovery()
    expect(fetchCandidates).toHaveBeenCalledOnce()
    expect(session.startFreshColdRestoreAgentResume).toHaveBeenCalledOnce()
  })

  it('still refuses a pane the user typed into, and the refusal stays spent', async () => {
    const session = buildSession('tab-1:leaf-typed', {
      lastTerminalInputAt: 12,
      lastRealUserInputAt: 12
    })
    await session.attemptAgentResumeRecovery()
    expect(fetchCandidates).not.toHaveBeenCalled()
    expect(session.agentResumeRecoveryAttempted).toBe(true)

    await session.attemptAgentResumeRecovery()
    expect(fetchCandidates).not.toHaveBeenCalled()
    expect(session.startFreshColdRestoreAgentResume).not.toHaveBeenCalled()
  })

  it('refuses a keystroke that lands while the host is answering', async () => {
    const session = buildSession('tab-1:leaf-typed-midscan')
    fetchCandidates.mockImplementationOnce(async () => {
      session.lastRealUserInputAt = 40
      return { kind: 'complete', candidates: [makeCandidate()] }
    })
    await session.attemptAgentResumeRecovery()
    expect(session.startFreshColdRestoreAgentResume).not.toHaveBeenCalled()
    expect(session.agentResumeRecoveryAttempted).toBe(true)
  })

  // Without xterm's provenance signal the pane cannot tell a keystroke from a mouse report, so
  // any accepted write counts: replacing a shell someone is typing in is the one outcome this
  // path must never produce.
  it('counts every accepted write when xterm cannot say what was typed', async () => {
    const session = buildSession('tab-1:leaf-no-provenance', {
      userInputActivityDisposable: null,
      lastTerminalInputAt: 12
    })
    await session.attemptAgentResumeRecovery()
    expect(fetchCandidates).not.toHaveBeenCalled()
    expect(session.startFreshColdRestoreAgentResume).not.toHaveBeenCalled()
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
