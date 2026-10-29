// SwapLabs fork (#4): every graph sync also tells the sidebar which delegated remote worker nests
// under which coordinator.

import { OrcaRuntimeWithBuildHeadlessMobileSessionBrowserTabs } from './build-headless-mobile-session-browser-tabs'
import { RuntimeDelegatedWorktreeEdgeProjection } from '../../runtime-delegated-worktree-edge-projection'
import type { RuntimeSyncWindowGraphResult } from '../../../../shared/runtime-session-contracts'

type Runtime = OrcaRuntimeWithBuildHeadlessMobileSessionBrowserTabs

export abstract class OrcaRuntimeWithDelegatedWorktreeEdgeSync extends OrcaRuntimeWithBuildHeadlessMobileSessionBrowserTabs {
  protected readonly delegatedWorktreeEdgeProjection = new RuntimeDelegatedWorktreeEdgeProjection({
    getDb: () => this.getOrchestrationDbIfAvailable(),
    getWorktreeId: (handle) => this.getTerminalWorktreeIdForHandle(handle),
    getHandleForPaneKey: (paneKey) => this.getTerminalHandleForPaneKey(paneKey)
  })

  override syncWindowGraph(
    ...args: Parameters<Runtime['syncWindowGraph']>
  ): RuntimeSyncWindowGraphResult {
    return {
      ...super.syncWindowGraph(...args),
      ...this.delegatedWorktreeEdgeProjection.buildSyncWindowGraphFields()
    }
  }
}
