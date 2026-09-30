import { AgentHookServerTabCleanup } from './server-tab-cleanup'
import {
  selectTerminalLossAgentResume,
  type TerminalLossAgentResume
} from './server-retained-identity'
import type { EnrichedAgentHookEventPayload, NormalizedLocalHook } from './server-types'

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
  protected retireUserEndedSession(
    ended: NonNullable<NormalizedLocalHook['userEndedSession']>,
    isReplay: boolean
  ): void {
    const paneKey = this.resolvePaneKeyAlias(ended.paneKey)
    const row = this.state.lastStatusByPaneKey.get(paneKey)
    // Why: a nested CLI inherits the pane key, so only the session the row names may retire it.
    if (row?.providerSession?.id !== ended.sessionId) {
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
