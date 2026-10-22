// SwapLabs fork (#30): a re-created pane that has no sleeping record of its own still resumes the
// agent its execution host's hook store kept for it when the pane's terminal was lost.

import { OrcaRuntimeWithBuildHeadlessMobileSessionBrowserTabs } from './build-headless-mobile-session-browser-tabs'
import { findPaneSleepingRecord } from './pane-sleeping-record'
import {
  HostPaneAgentResumes,
  type PreparedHostPaneAgentResume
} from '../../host-pane-agent-resume'
import { isWorktreeTerminalsSleepingError } from '../../worktree-terminals-sleeping-error'
import type { TerminalWorkspaceLaunchScope } from '../../runtime-legacy-worker-terminal-recovery-types'
import type { RestoredPaneTrigger } from '../../terminal/recovery/restored-pane-start'
import type { TuiAgent } from '../../../../shared/tui-agent'
import type { AgentLaunchRuntime } from '../../../../shared/agent-launch-runtime'
import type { RuntimeMobileSessionCreateTerminalResult } from '../../../../shared/runtime-session-contracts'
import type { RuntimeMobileSessionTerminalTab } from '../../../../shared/runtime-types'

/** An agent already reported in the pane, so a fresh launch (#7587) would start a new conversation. */
export const HOST_PANE_AGENT_REPORTED = 'agent-reported'

function hostPaneId(worktreeId: string, tab: RuntimeMobileSessionTerminalTab): string {
  return `${worktreeId}\0${tab.parentTabId}\0${tab.leafId}`
}

export abstract class OrcaRuntimeWithHostPaneAgentResumeStart extends OrcaRuntimeWithBuildHeadlessMobileSessionBrowserTabs {
  protected abstract resolveAgentLaunchRuntime(
    scope: TerminalWorkspaceLaunchScope,
    agent: TuiAgent | undefined
  ): AgentLaunchRuntime

  private readonly hostPaneAgentResumes = new HostPaneAgentResumes()

  /** Settles with another activation's re-creation of the pane; undefined when none runs. */
  protected hostPaneRecreationInFlight(
    worktreeId: string,
    tab: RuntimeMobileSessionTerminalTab
  ): Promise<void> | undefined {
    return this.hostPaneAgentResumes.inFlight(hostPaneId(worktreeId, tab))?.then(
      () => undefined,
      () => undefined
    )
  }

  protected trackHostPaneRecreation<T>(
    worktreeId: string,
    tab: RuntimeMobileSessionTerminalTab,
    recreation: Promise<T>
  ): Promise<T> {
    return this.hostPaneAgentResumes.track(hostPaneId(worktreeId, tab), recreation)
  }

  /**
   * For a pane with no sleeping record: starts it resuming the agent session the hook store kept
   * for it. Null when the store names none; `agent-reported` when an agent ran here but cannot.
   */
  protected async startHostPaneAgentResume(
    worktreeId: string,
    tab: RuntimeMobileSessionTerminalTab,
    {
      automatic = false,
      targetsHost = false,
      targetGroupId,
      sessionId
    }: RestoredPaneTrigger & { sessionId?: string }
  ): Promise<RuntimeMobileSessionCreateTerminalResult | typeof HOST_PANE_AGENT_REPORTED | null> {
    const paneKey = `${tab.parentTabId}:${tab.leafId}`
    const reported =
      (this.getAgentProviderSessionRowsForPaneFn?.(paneKey) ?? []).length > 0
        ? HOST_PANE_AGENT_REPORTED
        : null
    // Why: a pane with any record, even one upstream leaves alone (#29389), is upstream's to start.
    const resume = findPaneSleepingRecord(
      this.getWorkspaceSessionForWorktree(worktreeId),
      worktreeId,
      tab
    )
      ? null
      : await this.prepareHostPaneAgentResume(worktreeId, tab, paneKey, sessionId)
    if (!resume) {
      return reported
    }
    const { launch } = resume
    const create = (resumes: boolean): Promise<RuntimeMobileSessionCreateTerminalResult> =>
      this.createRuntimeOwnedMobileSessionTerminal(worktreeId, targetsHost, undefined, {
        identity: { tabId: tab.parentTabId, leafId: tab.leafId, sessionId },
        cwd: tab.startupCwd,
        launchAgent: resumes ? launch.agent : tab.launchAgent,
        // Why no spawnIntent: undeclared, the host paces this resume but never defers it.
        ...(resumes
          ? {
              command: launch.command,
              env: launch.env,
              startupCommandDelivery: launch.startupCommandDelivery,
              launchConfig: launch.launchConfig,
              resumeProviderSession: launch.providerSession,
              launchRuntime: launch.launchRuntime
            }
          : {}),
        targetGroupId,
        ...(automatic ? { refuseSleptWorktree: true } : {})
      })
    try {
      return await create(true)
    } catch (err) {
      // Why: a worktree the host slept meanwhile stays asleep; its shell would be refused too.
      if (isWorktreeTerminalsSleepingError(err)) {
        throw err
      }
      // Why: a launch-only refusal (auth switch, env conflict) must still leave a usable shell;
      // the pane keeps its resume identity for the next time its terminal is re-created.
      console.warn(`[host-pane-resume] resume spawn failed for ${paneKey}; opening a shell:`, err)
      return await create(false)
    } finally {
      resume.release()
    }
  }

  private prepareHostPaneAgentResume(
    worktreeId: string,
    tab: RuntimeMobileSessionTerminalTab,
    paneKey: string,
    sessionId: string | undefined
  ): Promise<PreparedHostPaneAgentResume | null> {
    const selectResume = this.selectTerminalLossAgentResumeFn
    const store = this.store
    if (!selectResume || !store) {
      return Promise.resolve(null)
    }
    const isPaneTerminalLive = (candidate: string): boolean =>
      [...this.ptysById.values()].some((pty) => pty.connected && pty.paneKey === candidate)
    return this.hostPaneAgentResumes.prepare({
      selectResume: () => selectResume(paneKey, isPaneTerminalLive),
      getSettings: () => store.getSettings(),
      resolveWorkspace: async (agent) => {
        const workspace = await this.resolveTerminalWorkspaceLaunchScope(`id:${worktreeId}`)
        return {
          connectionId: workspace.connectionId,
          launchRuntime: this.resolveAgentLaunchRuntime(workspace, agent)
        }
      },
      isStillPending: () => {
        const current = this.mobileSessionTabsByWorktree
          .get(worktreeId)
          ?.tabs.find(
            (candidate): candidate is RuntimeMobileSessionTerminalTab =>
              candidate.type === 'terminal' &&
              candidate.parentTabId === tab.parentTabId &&
              candidate.leafId === tab.leafId
          )
        const currentSessionId =
          current?.ptyId ?? current?.parentLayout?.ptyIdsByLeafId?.[tab.leafId] ?? undefined
        return (
          current !== undefined && currentSessionId === sessionId && !isPaneTerminalLive(paneKey)
        )
      }
    })
  }
}
