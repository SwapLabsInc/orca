import { resolvePaneScopedLaunchTuiAgent } from '@/lib/agent-status/evidence/pane-agent-evidence'
import { useAppStore } from '@/store'
import type { TuiAgent } from '../../../../../../shared/agent-launch/catalog/tui-agent'
import type { ConnectPanePtySession } from '../connect-pane-pty-session'

/** The agent THIS PANE hosted, from pane-keyed evidence only. `resolveExpectedLaunchTuiAgent`
 *  also accepts the tab's `launchAgent`, which names the tab's original pty and leaks onto a
 *  plain-shell split; a destructive decision (replacing a live shell with a recovered
 *  conversation) may not rest on it. Null means no evidence, never "an ordinary shell". */
export function installPaneScopedTuiAgent(session: ConnectPanePtySession): void {
  session.resolvePaneScopedTuiAgent = (): TuiAgent | null => {
    const state = useAppStore.getState()
    return resolvePaneScopedLaunchTuiAgent({
      paneStartupLaunchAgent: session.paneStartup?.launchAgent,
      paneStartupStatusAgent: session.paneStartup?.initialAgentStatus?.agent,
      registeredLaunchAgent: state.agentLaunchConfigByPaneKey[session.cacheKey]?.identity.agentType,
      statusEntryAgent: state.agentStatusByPaneKey[session.cacheKey]?.agentType,
      foregroundAgent: state.paneForegroundAgentByPaneKey[session.cacheKey]?.agent
    })
  }
}
