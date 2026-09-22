import type { AgentResumeCandidate, AgentResumeResolution } from '../../../shared/agent-resume-candidate'

export type AgentResumePaneAction =
  /** Respawn this pane with the candidate's resume argv. */
  | { kind: 'resume'; candidate: AgentResumeCandidate }
  /** Rung 5: offer the choice in the pane. */
  | { kind: 'choose'; candidates: readonly AgentResumeCandidate[] }
  | { kind: 'none'; reason: AgentResumePaneRefusal }

export type AgentResumePaneRefusal =
  | 'pane-owns-record'
  | 'pane-hidden'
  | 'pane-in-use'
  | 'resolver-refused'

export type AgentResumePaneInputs = {
  /** The pane's own sleeping record already answered; the synchronous cold-restore path owns it. */
  paneHasOwnRecord: boolean
  paneIsVisible: boolean
  /** Any byte the user has sent to this pane's shell since it spawned. */
  paneHasReceivedInput: boolean
  resolution: AgentResumeResolution
}

/**
 * Whether a pane with no resume handle should be respawned onto a recovered session.
 *
 * This runs AFTER the pane's plain shell has spawned, not instead of it. Holding every fresh
 * spawn behind a host round trip would tax the common case — a plain terminal in a workspace
 * that never ran an agent — for a recovery that only some panes need. So the shell appears at
 * its normal speed and a recovered session replaces it by respawning, which keeps the rule
 * that a resume only ever rides a spawn and is never typed into a live shell.
 *
 * Replacing a shell is destructive, so three gates guard it, and each one answers 'none':
 *  - the pane already has its own record, so the synchronous path owns it and a second resume
 *    here would fork the same transcript into two panes;
 *  - the pane is hidden, so nothing is respawned in bulk behind the user's back (the concern
 *    `restoreOnTabOpenOnly` already encodes: one wake must not respawn a whole workspace);
 *  - the user has already typed into the shell, which makes it theirs.
 */
export function decideAgentResumeForPane(inputs: AgentResumePaneInputs): AgentResumePaneAction {
  if (inputs.paneHasOwnRecord) {
    return { kind: 'none', reason: 'pane-owns-record' }
  }
  if (!inputs.paneIsVisible) {
    return { kind: 'none', reason: 'pane-hidden' }
  }
  if (inputs.paneHasReceivedInput) {
    return { kind: 'none', reason: 'pane-in-use' }
  }
  if (inputs.resolution.kind === 'resume') {
    return { kind: 'resume', candidate: inputs.resolution.candidate }
  }
  if (inputs.resolution.kind === 'choose') {
    return { kind: 'choose', candidates: inputs.resolution.candidates }
  }
  return { kind: 'none', reason: 'resolver-refused' }
}
