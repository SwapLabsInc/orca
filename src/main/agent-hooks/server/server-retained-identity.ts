import {
  agentProviderSessionsEqual,
  isResumableTuiAgent,
  normalizeAgentProviderSession,
  type AgentProviderSessionMetadata,
  type ResumableTuiAgent
} from '../../../shared/agent-session-resume'
import type { EnrichedAgentHookEventPayload } from './server-types'
import { isWslHookRelayConnectionId } from '../../../shared/wsl-hook-relay-contract'

/** Why a pane's live row gave way to a retained identity. */
export type RetainedIdentityCause = 'agent-ended' | 'terminal-loss'

export type TerminalLossAgentResume = {
  agent: ResumableTuiAgent
  providerSession: AgentProviderSessionMetadata
}

/** Whether a row still names a session its agent never ended: the agent's own row, an identity the
 *  agent published by itself (Pi), or one retained when the pane's terminal was lost. */
export function isResumableIdentityRow(row: EnrichedAgentHookEventPayload): boolean {
  return (
    row.providerSessionOnly !== true ||
    row.resumeAfterTerminalLoss === true ||
    row.retainedForLiveness !== true
  )
}

/** The hidden `providerSessionOnly` remnant a dropped row leaves, marked by why it was dropped. */
export function retainResumeIdentity(
  entry: EnrichedAgentHookEventPayload,
  cause: RetainedIdentityCause
): EnrichedAgentHookEventPayload {
  const {
    launchToken: _launchToken,
    resumeAfterTerminalLoss: _resumeAfterTerminalLoss,
    terminalHandle,
    ...resumeIdentity
  } = entry
  if (cause === 'agent-ended') {
    return {
      ...resumeIdentity,
      ...(terminalHandle ? { terminalHandle } : {}),
      providerSessionOnly: true,
      retainedForLiveness: true
    }
  }
  // Why: losing the terminal is not the agent ending, but an identity already kept for an agent
  // that ended stays ended. The handle goes with the terminal it named, and so does the process
  // presence, so no probe retires the remnant.
  const resumable = !entry.structuredHost && isResumableIdentityRow(entry)
  const { agentPresence: _agentPresence, ...terminalIdentity } = resumeIdentity
  return {
    ...terminalIdentity,
    providerSessionOnly: true,
    retainedForLiveness: true,
    ...(resumable ? { resumeAfterTerminalLoss: true as const } : {})
  }
}

/**
 * The agent session the execution host may resume when it re-creates `paneKey`'s terminal.
 *
 * Only a local pane qualifies: an SSH relay can outlive its client, so a lost route is no evidence
 * the remote agent stopped. One conversation belongs to one pane — a pane whose terminal still
 * runs it keeps it, and otherwise the pane that reported it last does.
 */
export function selectTerminalLossAgentResume(
  rows: Iterable<EnrichedAgentHookEventPayload>,
  paneKey: string,
  isPaneTerminalLive: (paneKey: string) => boolean
): TerminalLossAgentResume | null {
  const candidates = [...rows]
  const row = candidates.find((candidate) => candidate.paneKey === paneKey)
  // Why: an SSH relay can outlive its client. A WSL relay runs on this host, but only one that
  // reports user-ended sessions can prove its agent was not quit.
  const route = row?.connectionId
  const resumableRoute =
    route == null || (isWslHookRelayConnectionId(route) && row?.reportsUserEndedSessions === true)
  if (!row || !resumableRoute || row.structuredHost || !isResumableIdentityRow(row)) {
    return null
  }
  const agent = row.payload.agentType
  const providerSession = normalizeAgentProviderSession(row.providerSession)
  if (!isResumableTuiAgent(agent) || !providerSession) {
    return null
  }
  for (const other of candidates) {
    if (
      other.paneKey === paneKey ||
      other.payload.agentType !== agent ||
      !isResumableIdentityRow(other) ||
      !agentProviderSessionsEqual(agent, other.providerSession ?? undefined, providerSession)
    ) {
      continue
    }
    if (
      isPaneTerminalLive(other.paneKey) ||
      other.receivedAt > row.receivedAt ||
      (other.receivedAt === row.receivedAt && other.paneKey < paneKey)
    ) {
      return null
    }
  }
  return { agent, providerSession }
}
