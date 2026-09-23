import type {
  AgentResumeCandidate,
  AgentResumeResolution
} from '../../../shared/agent-resume-candidate'
import type { ExecutionHostId } from '../../../shared/execution-host'
import type { ResumableTuiAgent } from '../../../shared/agent-session-resume'
import type { AgentResumeCandidateScan } from './agent-resume-candidate-source'
import { resolveAgentResumeCandidate } from './agent-resume-candidate-resolver'
import { decideAgentResumeForPane, type AgentResumePaneAction } from './agent-resume-pane-decision'

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
  /** The provider session the authoritative status store names for THIS pane, if any. */
  readPaneProviderSessionId?: () => string | null
  readPaneState: () => AgentResumePaneGateState
  /** Read AFTER the host scan, never before: the scan takes ~2s, and a sibling pane can claim
   *  or reserve a session inside that window. */
  readClaimedSessionIds: () => ReadonlySet<string>
  fetchCandidates: (args: {
    worktreePath: string
    executionHostId: ExecutionHostId | null
  }) => Promise<AgentResumeCandidateScan>
  /** Reserves the candidate and respawns; false means another pane reserved it first. */
  resume: (candidate: AgentResumeCandidate) => boolean
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

  const scan = await args.fetchCandidates({
    worktreePath: args.worktreePath,
    executionHostId: args.executionHostId
  })
  // An incomplete scan is `unverifiable`, not "no candidates": its subset could name the wrong
  // conversation as the sole survivor, and its emptiness is no evidence of absence. The caller
  // keeps the attempt unspent so a reachable host can still answer.
  if (scan.kind !== 'complete') {
    return { kind: 'none', reason: 'scan-unverifiable' }
  }
  const resolution = resolveAgentResumeCandidate({
    candidates: scan.candidates,
    paneAgent: args.paneAgent,
    paneProviderSessionId: args.readPaneProviderSessionId?.() ?? null,
    worktreePath: args.worktreePath,
    claimedSessionIds: args.readClaimedSessionIds()
  })

  const decision = decideAgentResumeForPane({ ...args.readPaneState(), resolution })
  if (decision.kind === 'resume') {
    // The claim set above is a read; this is the check-and-reserve that decides it.
    if (!args.resume(decision.candidate)) {
      return { kind: 'none', reason: 'session-claimed' }
    }
  } else if (decision.kind === 'choose') {
    args.offerChoice(args.paneKey, decision.candidates)
  }
  return decision
}
