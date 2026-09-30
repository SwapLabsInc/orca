import { AgentHookServerTabCleanup } from './server-tab-cleanup'
import {
  selectTerminalLossAgentResume,
  type TerminalLossAgentResume
} from './server-retained-identity'
import type { EnrichedAgentHookEventPayload, UserEndedAgentSession } from './server-types'
import { hashLaunchToken } from './server-status-identity'

export abstract class AgentHookServerTerminalLossResume extends AgentHookServerTabCleanup {
  /** The agent session the execution host may resume when it re-creates `paneKey`'s terminal. */
  selectTerminalLossResume(
    paneKey: string,
    isPaneTerminalLive: (paneKey: string) => boolean
  ): TerminalLossAgentResume | null {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Main admits enriched legacy rows; the shared view declares their base event type.
    const rows = this.state.lastStatusByPaneKey.values() as Iterable<EnrichedAgentHookEventPayload>
    return selectTerminalLossAgentResume(
      rows,
      this.resolvePaneKeyAlias(paneKey),
      isPaneTerminalLive
    )
  }

  /** The agent reported that the user ended its session: the pane keeps the identity for a manual
   *  resume, but a later loss of its terminal must not bring the agent back. */
  protected retireUserEndedSession(ended: UserEndedAgentSession, isReplay: boolean): void {
    const paneKey = this.resolvePaneKeyAlias(ended.paneKey)
    const row = this.state.lastStatusByPaneKey.get(paneKey)
    // Why: a nested CLI inherits the pane key, so only the session the row names may retire it,
    // and only the route that produced the row may speak for it.
    if (
      row?.providerSession?.id !== ended.sessionId ||
      (row.connectionId ?? null) !== (ended.connectionId ?? null)
    ) {
      return
    }
    // Why: a resume keeps the session id under a new launch token, so a late SessionEnd from the
    // previous process must not retire the one that replaced it.
    const endedToken = ended.launchToken?.trim()
    const rowToken = row.launchToken?.trim()
    const rowTokenHash = rowToken
      ? hashLaunchToken(rowToken)
      : this.hydratedLaunchTokenHashByPaneKey.get(paneKey)
    if (endedToken && rowTokenHash && hashLaunchToken(endedToken) !== rowTokenHash) {
      return
    }
    const disposition = this.getAgentStatusDisposition(paneKey, {
      source: 'claude',
      hookEventName: 'SessionEnd',
      isReplay,
      launchToken: ended.launchToken
    })
    if (disposition === 'accept') {
      this.reconcileEndedProcessForPaneKeys([paneKey], { preserveResumeIdentity: true })
    }
  }
}
