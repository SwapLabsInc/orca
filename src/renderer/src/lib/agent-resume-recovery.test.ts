import { describe, expect, it, vi } from 'vitest'
import type { AgentResumeCandidate } from '../../../shared/agent-resume-candidate'
import {
  recoverAgentSessionForPane,
  type AgentResumePaneGateState,
  type RecoverAgentSessionArgs
} from './agent-resume-recovery'

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

const OPEN_GATES: AgentResumePaneGateState = {
  paneHasOwnRecord: false,
  paneIsVisible: true,
  paneHasReceivedInput: false
}

function makeArgs(overrides: Partial<RecoverAgentSessionArgs> = {}): RecoverAgentSessionArgs {
  return {
    paneKey: 'tab:leaf',
    worktreePath: '/w',
    executionHostId: null,
    paneAgent: 'claude',
    readPaneState: () => OPEN_GATES,
    readClaimedSessionIds: () => new Set<string>(),
    fetchCandidates: async () => [makeCandidate()],
    resume: vi.fn(() => true),
    offerChoice: vi.fn(),
    ...overrides
  }
}

describe('recoverAgentSessionForPane', () => {
  it('resumes a sole substantial candidate', async () => {
    const args = makeArgs()
    const decision = await recoverAgentSessionForPane(args)
    expect(decision.kind).toBe('resume')
    expect(args.resume).toHaveBeenCalledOnce()
  })

  it('offers a choice when the resolver refuses to decide', async () => {
    const offerChoice = vi.fn()
    const args = makeArgs({
      offerChoice,
      fetchCandidates: async () => [
        makeCandidate(),
        makeCandidate({
          providerSession: { key: 'session_id', id: 'b171319f-6711-4537-89be-00f26ccc7e32' },
          updatedAt: 1_788_000_000_000
        })
      ]
    })
    const decision = await recoverAgentSessionForPane(args)
    expect(decision.kind).toBe('choose')
    expect(offerChoice).toHaveBeenCalledWith('tab:leaf', expect.any(Array))
  })

  // Why: asking the host costs seconds of transcript scanning. A pane the gates already
  // refuse must not pay for an answer nobody will act on.
  it.each([
    ['hidden', { ...OPEN_GATES, paneIsVisible: false }],
    ['already in use', { ...OPEN_GATES, paneHasReceivedInput: true }],
    ['already holding a record', { ...OPEN_GATES, paneHasOwnRecord: true }]
  ])('never asks the host for a pane that is %s', async (_label, state) => {
    const fetchCandidates = vi.fn(async () => [makeCandidate()])
    const decision = await recoverAgentSessionForPane(
      makeArgs({ readPaneState: () => state, fetchCandidates })
    )
    expect(fetchCandidates).not.toHaveBeenCalled()
    expect(decision.kind).toBe('none')
  })

  // Why: the scan is long enough for the user to start typing. Replacing a shell someone is
  // using is the one outcome this path must never produce.
  it('stands down when the user types while the host is answering', async () => {
    let typed = false
    const resume = vi.fn(() => true)
    const decision = await recoverAgentSessionForPane(
      makeArgs({
        resume,
        readPaneState: () => ({ ...OPEN_GATES, paneHasReceivedInput: typed }),
        fetchCandidates: async () => {
          typed = true
          return [makeCandidate()]
        }
      })
    )
    expect(decision).toEqual({ kind: 'none', reason: 'pane-in-use' })
    expect(resume).not.toHaveBeenCalled()
  })

  it('stands down when the pane is hidden while the host is answering', async () => {
    let visible = true
    const decision = await recoverAgentSessionForPane(
      makeArgs({
        readPaneState: () => ({ ...OPEN_GATES, paneIsVisible: visible }),
        fetchCandidates: async () => {
          visible = false
          return [makeCandidate()]
        }
      })
    )
    expect(decision).toEqual({ kind: 'none', reason: 'pane-hidden' })
  })

  it('does nothing when the host returns no usable candidate', async () => {
    const args = makeArgs({ fetchCandidates: async () => [] })
    const decision = await recoverAgentSessionForPane(args)
    expect(decision).toEqual({ kind: 'none', reason: 'resolver-refused' })
    expect(args.resume).not.toHaveBeenCalled()
  })

  // EP-STATE: the ~2s scan is exactly the window in which a sibling pane claims the session
  // this pane resolved, so the set that decides must be the one read after the await.
  it('re-reads the claim set after the host answers', async () => {
    const claimed = new Set<string>()
    const args = makeArgs({
      readClaimedSessionIds: () => claimed,
      fetchCandidates: async () => {
        claimed.add('a521d69e-9181-481c-ab8e-998a1881b731')
        return [makeCandidate()]
      }
    })
    const decision = await recoverAgentSessionForPane(args)
    expect(decision).toEqual({ kind: 'none', reason: 'resolver-refused' })
    expect(args.resume).not.toHaveBeenCalled()
  })

  // The final claim is the reservation inside `resume`; a refusal means another pane won it.
  it('reports a refused reservation instead of resuming', async () => {
    const args = makeArgs({ resume: vi.fn(() => false) })
    const decision = await recoverAgentSessionForPane(args)
    expect(decision).toEqual({ kind: 'none', reason: 'session-claimed' })
  })

  it('never offers a session another live pane already holds', async () => {
    const args = makeArgs({
      readClaimedSessionIds: () => new Set(['a521d69e-9181-481c-ab8e-998a1881b731'])
    })
    const decision = await recoverAgentSessionForPane(args)
    expect(decision.kind).toBe('none')
    expect(args.resume).not.toHaveBeenCalled()
  })
})
