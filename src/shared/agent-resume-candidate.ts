import type { ExecutionHostId } from './execution-host'
import type { AgentProviderSessionMetadata, ResumableTuiAgent } from './agent-session-resume'

/** One resumable conversation an execution host holds for a workspace, normalized from
 *  whichever source named it: the pane's own sleeping record, or that host's session index. */
export type AgentResumeCandidate = {
  agent: ResumableTuiAgent
  providerSession: AgentProviderSessionMetadata
  /** Host-reported directory the session ran in; the scope the candidate was matched on. */
  cwd: string
  title: string
  /** Last activity, epoch ms on the HOST's clock — never comparable to a client timestamp. */
  updatedAt: number
  messageCount: number
  branch: string | null
  /** Stamped by the desktop from the host it addressed, never trusted from the answer. */
  executionHostId: ExecutionHostId | null
}

/** Which rung answered. Diagnostics and tests read this; it is never shown to the user. */
export type AgentResumeResolutionReason =
  | 'pane-record'
  | 'sole-candidate'
  | 'no-candidates'
  | 'every-candidate-claimed'
  | 'ambiguous'

export type AgentResumeResolution =
  | {
      kind: 'resume'
      candidate: AgentResumeCandidate
      reason: Extract<AgentResumeResolutionReason, 'pane-record' | 'sole-candidate'>
    }
  /** Last rung: several candidates survived every filter and no evidence separates them. */
  | { kind: 'choose'; candidates: readonly AgentResumeCandidate[] }
  | {
      kind: 'none'
      reason: Extract<
        AgentResumeResolutionReason,
        'no-candidates' | 'every-candidate-claimed' | 'ambiguous'
      >
    }

/** Below this, a transcript is a probe or an aborted start rather than work worth resuming.
 *  Resuming the wrong session forks it unrecoverably, so a thin transcript that merely sorts
 *  newest must never outrank a substantial one (a 39-line diagnostic beat a 758-line session
 *  in the field before this floor existed). */
export const AGENT_RESUME_SUBSTANCE_FLOOR_MESSAGES = 50
