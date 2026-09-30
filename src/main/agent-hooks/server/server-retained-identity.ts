import {
  agentProviderSessionsEqual,
  isResumableTuiAgent,
  normalizeAgentProviderSession,
  type AgentProviderSessionMetadata,
  type ResumableTuiAgent
} from '../../../shared/agent-session-resume'
import type { EnrichedAgentHookEventPayload } from './server-types'

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
  if (!row || row.connectionId !== null || row.structuredHost || !isResumableIdentityRow(row)) {
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
