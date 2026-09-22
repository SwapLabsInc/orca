import type {
  AgentResumeCandidate,
  AgentResumeResolution
} from '../../../shared/agent-resume-candidate'
import type { ExecutionHostId } from '../../../shared/execution-host'
import type { ResumableTuiAgent } from '../../../shared/agent-session-resume'
import { resolveAgentResumeCandidate } from './agent-resume-candidate-resolver'
import {
  decideAgentResumeForPane,
  type AgentResumePaneAction
} from './agent-resume-pane-decision'

/** The three destructive gates, read live rather than captured — asking the host takes
 *  seconds, and the pane can be hidden or typed into while the answer is in flight. */
export type AgentResumePaneGateState = {
  paneHasOwnRecord: boolean
  paneIsVisible: boolean
  paneHasReceivedInput: boolean
}

export type RecoverAgentSessionArgs = {
  paneKey: string
  worktreePath: string
  executionHostId: ExecutionHostId | null
  paneAgent: ResumableTuiAgent | null
  readPaneState: () => AgentResumePaneGateState
  tabLastSessionId?: string | null
  tabCreatedAt?: number | null
  tabLastSeenAt?: number | null
  claimedSessionIds: ReadonlySet<string>
  fetchCandidates: (args: {
    worktreePath: string
    executionHostId: ExecutionHostId | null
  }) => Promise<readonly AgentResumeCandidate[]>
  resume: (candidate: AgentResumeCandidate) => void
  offerChoice: (paneKey: string, candidates: readonly AgentResumeCandidate[]) => void
}

/** Only the gates are being consulted; every gate outranks this placeholder verdict. */
const GATES_ONLY: AgentResumeResolution = { kind: 'none', reason: 'no-candidates' }

/**
 * Recovers a pane whose resume handle was lost, after its plain shell has spawned.
 *
 * The gates are checked BEFORE the host is asked, because asking is not free: the answer comes
 * from a scan of the host's transcripts, measured at ~2s on a host holding 1200 of them. A hidden
 * pane, a pane the user is already typing in, and a pane that still owns its record cost nothing.
 *
 * They are then checked AGAIN against freshly read state, because that scan is long enough for
 * the user to have typed into the shell or switched away — and replacing a shell someone is
 * using is the one outcome this whole path must never produce.
 */
export async function recoverAgentSessionForPane(
  args: RecoverAgentSessionArgs
): Promise<AgentResumePaneAction> {
  const preGate = decideAgentResumeForPane({ ...args.readPaneState(), resolution: GATES_ONLY })
  if (preGate.kind === 'none' && preGate.reason !== 'resolver-refused') {
    return preGate
  }

  const candidates = await args.fetchCandidates({
    worktreePath: args.worktreePath,
    executionHostId: args.executionHostId
  })
  const resolution = resolveAgentResumeCandidate({
    candidates,
    paneAgent: args.paneAgent,
    worktreePath: args.worktreePath,
    tabLastSessionId: args.tabLastSessionId,
    tabCreatedAt: args.tabCreatedAt,
    tabLastSeenAt: args.tabLastSeenAt,
    claimedSessionIds: args.claimedSessionIds
  })

  const decision = decideAgentResumeForPane({ ...args.readPaneState(), resolution })
  if (decision.kind === 'resume') {
    args.resume(decision.candidate)
  } else if (decision.kind === 'choose') {
    args.offerChoice(args.paneKey, decision.candidates)
  }
  return decision
}
