import { AgentHookServerPaneSleep } from './server-pane-sleep'
import type { AgentProcessPresence } from '../../../shared/agent-status/process/agent-process-presence'
import { admitLegacyAgentStatus } from '../../../shared/agent-hook-listener/listener-state'
import { AGENT_STATUS_2A_CURRENT_PRODUCER_MODE } from '../../../shared/agent-status/transport/agent-status-legacy-adapter'
import type { EndedProcessReconciliationOptions } from './server-cleanup'
import { retainResumeIdentity, type RetainedIdentityCause } from './server-retained-identity'
import type { ClearPaneStateOptions, EnrichedAgentHookEventPayload } from './server-types'

/** SwapLabs #30: the resume identity a pane keeps when its live row goes, and why it went. */
export abstract class AgentHookServerRetainedPaneIdentity extends AgentHookServerPaneSleep {
  /** Resume identity survives teardown without claiming live work. */
  protected toRetainedProviderSessionRow(
    entry: EnrichedAgentHookEventPayload | null | undefined,
    cause: RetainedIdentityCause = 'agent-ended'
  ): EnrichedAgentHookEventPayload | null {
    if (
      !entry?.providerSession ||
      !entry.payload.agentType ||
      entry.payload.agentType === 'unknown'
    ) {
      return null
    }
    return retainResumeIdentity(entry, cause)
  }

  /** Re-admits the identity a pane retains once its live claims are gone. */
  protected admitRetainedIdentity(retained: EnrichedAgentHookEventPayload): void {
    admitLegacyAgentStatus(
      this.state,
      'main-status-cleanup',
      retained,
      AGENT_STATUS_2A_CURRENT_PRODUCER_MODE
    )
  }

  /** The identity a torn-down pane keeps: resumable unless the caller knows its agent ended first. */
  protected retainedPaneIdentity(
    previous: EnrichedAgentHookEventPayload | undefined,
    options: ClearPaneStateOptions | undefined
  ): EnrichedAgentHookEventPayload | null {
    const retainIdentity = options?.retainIdentity ?? 'terminal-loss'
    const identity = retainIdentity
      ? this.toRetainedProviderSessionRow(previous, retainIdentity)
      : null
    // Why: an ended owner stops answering probes, and its late hooks cannot claim the pane again.
    return identity && options?.endedPresence
      ? { ...identity, agentPresence: options.endedPresence }
      : identity
  }

  /** Clears a pane whose agent's process ended; returns true because it owns the row it leaves. */
  protected clearEndedPaneState(
    paneKey: string,
    options: EndedProcessReconciliationOptions | undefined,
    endedPresence: AgentProcessPresence | undefined
  ): true {
    // Why: an exit only the process proves cannot tell a lost terminal from an ended agent. Claude
    // reports `other` when a signal ends it, and a probe after a restart finds every agent of a
    // lost terminal gone, so such an exit stays resumable. A session the user ended is retired as
    // agent-ended, and a shell that outlived the agent retires it on confirmation.
    const retainIdentity: RetainedIdentityCause =
      options?.userEnded ||
      (options?.preserveResumeIdentity && !options.endedPresence && !options.terminalLost)
        ? 'agent-ended'
        : 'terminal-loss'
    this.clearPaneState(paneKey, { retainIdentity, endedPresence })
    return true
  }
}
