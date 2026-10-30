// SwapLabs fork (#30): a re-created pane resumes the agent its execution host's hook store kept for
// it through upstream's hook-row resume (#34054), under the host's terminal-loss rules, with the
// settings-default flags (#40), no declared restore intent, and a plain shell if its spawn fails.

import { OrcaRuntimeWithDelegatedWorktreeEdgeSync } from './delegated-worktree-edge-graph-sync'
import { findPaneSleepingRecord } from './pane-sleeping-record'
import { isWorktreeTerminalsSleepingError } from '../../worktree-terminals-sleeping-error'
import type { RestoredPaneTrigger } from '../../terminal/recovery/restored-pane-start'
import type {
  MobileTerminalCommand,
  MobileTerminalResumeCommand
} from '../../terminal/launch/mobile-terminal-startup'
import {
  agentProviderSessionsEqual,
  type SleepingAgentSessionRecord
} from '../../../../shared/agent-session-resume'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import {
  resolveTuiAgentLaunchArgs,
  resolveTuiAgentLaunchEnv
} from '../../../../shared/tui-agent-launch-defaults'
import type { RuntimeMobileSessionCreateTerminalResult } from '../../../../shared/runtime-session-contracts'
import type { RuntimeMobileSessionTerminalTab } from '../../../../shared/runtime-types'

function hostPaneId(worktreeId: string, tab: RuntimeMobileSessionTerminalTab): string {
  return `${worktreeId}\0${tab.parentTabId}\0${tab.leafId}`
}

export abstract class OrcaRuntimeWithHostPaneAgentResumeStart extends OrcaRuntimeWithDelegatedWorktreeEdgeSync {
  private readonly hostPaneRecreations = new Map<string, Promise<unknown>>()

  /** Settles with another activation's re-creation of the pane; undefined when none runs. */
  protected hostPaneRecreationInFlight(
    worktreeId: string,
    tab: RuntimeMobileSessionTerminalTab
  ): Promise<void> | undefined {
    return this.hostPaneRecreations.get(hostPaneId(worktreeId, tab))?.then(
      () => undefined,
      () => undefined
    )
  }

  protected trackHostPaneRecreation<T>(
    worktreeId: string,
    tab: RuntimeMobileSessionTerminalTab,
    recreation: Promise<T>
  ): Promise<T> {
    const paneId = hostPaneId(worktreeId, tab)
    this.hostPaneRecreations.set(paneId, recreation)
    const forget = (): void => {
      if (this.hostPaneRecreations.get(paneId) === recreation) {
        this.hostPaneRecreations.delete(paneId)
      }
    }
    recreation.then(forget, forget)
    return recreation
  }

  /**
   * The hook-row record a re-created pane may resume, relaunched with the host's settings-default
   * flags; null when the host store keeps that session for a manual resume only, such as one the
   * user ended (docs/reference/swaplabs-agent-resume.md).
   */
  protected admitHostPaneAgentResume(
    tab: RuntimeMobileSessionTerminalTab,
    record: SleepingAgentSessionRecord
  ): SleepingAgentSessionRecord | null {
    const select = this.selectTerminalLossAgentResumeFn
    if (select) {
      const isPaneTerminalLive = (paneKey: string): boolean =>
        [...this.ptysById.values()].some((pty) => pty.connected && pty.paneKey === paneKey)
      const resume = select(makePaneKey(tab.parentTabId, tab.leafId), isPaneTerminalLive)
      if (
        resume?.agent !== record.agent ||
        !agentProviderSessionsEqual(record.agent, resume.providerSession, record.providerSession)
      ) {
        return null
      }
    }
    const settings = this.store?.getSettings()
    return settings
      ? {
          ...record,
          launchConfig: {
            agentArgs: resolveTuiAgentLaunchArgs(record.agent, settings),
            agentEnv: resolveTuiAgentLaunchEnv(record.agent, settings)
          }
        }
      : record
  }

  /** Whether the pane's startup resumes the session its hook rows name, not a saved record. */
  protected resumesFromHostHookStore(
    worktreeId: string,
    tab: RuntimeMobileSessionTerminalTab,
    startup: MobileTerminalCommand | MobileTerminalResumeCommand | undefined
  ): boolean {
    return (
      startup !== undefined &&
      'resumeProviderSession' in startup &&
      !findPaneSleepingRecord(this.getWorkspaceSessionForWorktree(worktreeId), worktreeId, tab)
    )
  }

  /** Why undeclared: the host paces a hook-store resume but never defers or pauses it (#41). */
  protected restoreSpawnIntent(
    hostHookResume: boolean,
    automatic: boolean
  ): 'automatic-restore' | 'user-resume' | undefined {
    if (hostHookResume) {
      return undefined
    }
    return automatic ? 'automatic-restore' : 'user-resume'
  }

  /**
   * The pane's plain shell after a refused hook-store resume (an auth switch, an env conflict); the
   * hook store keeps the session for the pane's next re-creation. Null for any other startup, and
   * for a slept worktree, which refuses the shell too.
   */
  protected openShellAfterRefusedHostResume(
    hostHookResume: boolean,
    worktreeId: string,
    tab: RuntimeMobileSessionTerminalTab,
    err: unknown,
    trigger: RestoredPaneTrigger & { sessionId?: string }
  ): Promise<RuntimeMobileSessionCreateTerminalResult> | null {
    if (!hostHookResume || isWorktreeTerminalsSleepingError(err)) {
      return null
    }
    const paneKey = makePaneKey(tab.parentTabId, tab.leafId)
    console.warn(`[host-pane-resume] resume spawn failed for ${paneKey}; opening a shell:`, err)
    return this.createRuntimeOwnedMobileSessionTerminal(
      worktreeId,
      trigger.targetsHost ?? false,
      undefined,
      {
        identity: { tabId: tab.parentTabId, leafId: tab.leafId, sessionId: trigger.sessionId },
        cwd: tab.startupCwd,
        launchAgent: tab.launchAgent,
        targetGroupId: trigger.targetGroupId,
        ...(trigger.automatic ? { refuseSleptWorktree: true } : {})
      }
    )
  }
}
