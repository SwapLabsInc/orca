import type { AgentStatusEntry } from '../../../shared/agent-status-types'
import { parsePaneKey } from '../../../shared/stable-pane-id'

/** Only the terminal maps the rule reads; a plain shape so the rule is testable without a store. */
export type AgentResumeClaimState = {
  agentStatusByPaneKey: Readonly<Record<string, AgentStatusEntry | undefined>>
  terminalLayoutsByTabId: Readonly<
    Record<string, { ptyIdsByLeafId?: Record<string, string | undefined> } | undefined>
  >
}

/** The three verdicts docs/reference/ssh-execution-boundary.md allows about a pane, with no
 *  synonyms: a bound PTY is `live`, a tab this renderer still holds but cannot see a binding for is
 *  `unverifiable` (mid cold restore, or a host mirror that has not published the handle yet), and
 *  only a tab the renderer no longer holds at all is `exited`. */
export type AgentResumePaneLiveness = 'live' | 'unverifiable' | 'exited'

export function resolveAgentResumePaneLiveness(
  state: AgentResumeClaimState,
  paneKey: string
): AgentResumePaneLiveness {
  const pane = parsePaneKey(paneKey)
  if (!pane) {
    return 'unverifiable'
  }
  const layout = state.terminalLayoutsByTabId[pane.tabId]
  if (!layout) {
    return 'exited'
  }
  return layout.ptyIdsByLeafId?.[pane.leafId] ? 'live' : 'unverifiable'
}

/**
 * THE PANE-IDENTITY CLAIM RULE: which provider sessions a recovering pane must not resume.
 *
 * Liveness is never derived from `state`, in either direction:
 *  - `state !== 'done'` is too BROAD. After a host restart the hook server republishes the
 *    recovering pane's own persisted row as `restoredUnconfirmed`, provider session included
 *    (main/agent-hooks/server/server-hydration.ts). Counting it made the pane treat ITS OWN
 *    session as claimed, so the sole candidate was filtered out and a restart during
 *    `working`/`blocked`/`waiting` left a plain shell — the feature's primary scenario.
 *  - `state !== 'done'` is also too NARROW. `done` means "task complete but pane live"
 *    (agent-status.ts), not exited, so excluding every `done` row let a live idle pane's
 *    transcript be resumed into a second pane: two agents on one transcript.
 *
 * So ownership comes from pane identity and liveness from the pane's own terminal binding:
 *  - a row whose pane key IS the recovering pane's is never a claim against it, whatever its state;
 *  - any other pane's row is a claim whenever that pane is `live` or `unverifiable`, whatever its
 *    state — loss of contact is not death, and a wrong resume forks a transcript unrecoverably;
 *  - only a pane this renderer positively no longer holds releases its session.
 */
export function agentResumeSessionsClaimedByOtherPanes(
  state: AgentResumeClaimState,
  paneKey: string
): Set<string> {
  const claimed = new Set<string>()
  for (const [rowPaneKey, entry] of Object.entries(state.agentStatusByPaneKey)) {
    if (!entry?.providerSession || rowPaneKey === paneKey) {
      continue
    }
    if (resolveAgentResumePaneLiveness(state, rowPaneKey) !== 'exited') {
      claimed.add(entry.providerSession.id)
    }
  }
  return claimed
}
