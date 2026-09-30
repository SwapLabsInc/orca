import type { TerminalLossAgentResume } from '../agent-hooks/server'
import type {
  RuntimeMobileSessionTabsSnapshot,
  RuntimeMobileSessionTerminalTab
} from '../../shared/runtime-types'
import { makePaneKey } from '../../shared/stable-pane-id'
import type { TerminalWorkspaceLaunchScope } from './runtime-legacy-worker-terminal-recovery-types'
import {
  agentProviderSessionIdentityKey,
  agentProviderSessionsEqual,
  type AgentProviderSessionMetadata,
  type ResumableTuiAgent,
  type SleepingAgentLaunchConfig
} from '../../shared/agent-session-resume'
import {
  resolveAgentStartupPlanInputs,
  type AgentStartupSettings
} from '../../shared/agent-startup-plan-inputs'
import type { StartupCommandDelivery } from '../../shared/codex-startup-delivery'
import type { TuiAgent } from '../../shared/tui-agent'
import { isTuiAgentEnabled } from '../../shared/tui-agent-selection'
import { buildAgentResumeStartupPlan } from '../../shared/tui-agent-startup'

export type HostPaneAgentResumeLaunch = {
  agent: ResumableTuiAgent
  providerSession: AgentProviderSessionMetadata
  command: string
  env?: Record<string, string>
  launchConfig: SleepingAgentLaunchConfig
  startupCommandDelivery?: StartupCommandDelivery
}

export type PreparedHostPaneAgentResume = {
  launch: HostPaneAgentResumeLaunch
  /** Lets another pane claim the session again once this spawn settled either way. */
  release: () => void
}

export type HostPaneAgentResumeInputs = {
  /** The host store's answer for the pane; re-read after every await. */
  selectResume: () => TerminalLossAgentResume | null
  getSettings: () => AgentStartupSettings & { disabledTuiAgents?: readonly TuiAgent[] }
  resolveWorkspace: () => Promise<{
    path: string
    connectionId: string | null
    platform: NodeJS.Platform
  }>
  markWorkspaceTrusted: (agent: ResumableTuiAgent, workspacePath: string) => Promise<void>
  /** The pane still exists, is still bound to the lost session, and nothing re-created it yet. */
  isStillPending: () => boolean
}

function providerSessionKey(resume: TerminalLossAgentResume): string {
  return agentProviderSessionIdentityKey(resume.agent, resume.providerSession)
}

/**
 * The execution host's half of resuming an agent after its pane's terminal was lost: which pane
 * is being re-created right now, and which provider sessions a re-creation is resuming.
 */
export class HostPaneAgentResumes {
  private readonly resumingSessions = new Set<string>()
  private readonly materializations = new Map<string, Promise<unknown>>()

  /** The re-creation of `paneId` another activation already started, if any. */
  inFlight(paneId: string): Promise<unknown> | undefined {
    return this.materializations.get(paneId)
  }

  track<T>(paneId: string, materialization: Promise<T>): Promise<T> {
    this.materializations.set(paneId, materialization)
    const forget = (): void => {
      if (this.materializations.get(paneId) === materialization) {
        this.materializations.delete(paneId)
      }
    }
    materialization.then(forget, forget)
    return materialization
  }

  /** Builds the resume launch for a pane the host is about to re-create, or null for a plain shell. */
  async prepare(inputs: HostPaneAgentResumeInputs): Promise<PreparedHostPaneAgentResume | null> {
    const resume = inputs.selectResume()
    if (!resume) {
      return null
    }
    const settings = inputs.getSettings()
    if (!isTuiAgentEnabled(resume.agent, settings.disabledTuiAgents)) {
      return null
    }
    let launch: HostPaneAgentResumeLaunch
    try {
      const workspace = await inputs.resolveWorkspace()
      // Why: an SSH relay can outlive its client; only the relay may decide its PTY is gone.
      if (workspace.connectionId) {
        return null
      }
      const plan = buildAgentResumeStartupPlan({
        ...resolveAgentStartupPlanInputs({
          agent: resume.agent,
          settings,
          platform: workspace.platform,
          isRemote: false
        }),
        agent: resume.agent,
        providerSession: resume.providerSession
      })
      if (!plan) {
        return null
      }
      await inputs.markWorkspaceTrusted(resume.agent, workspace.path)
      launch = {
        agent: resume.agent,
        providerSession: resume.providerSession,
        command: plan.launchCommand,
        ...(plan.env ? { env: plan.env } : {}),
        launchConfig: plan.launchConfig,
        ...(plan.startupCommandDelivery
          ? { startupCommandDelivery: plan.startupCommandDelivery }
          : {})
      }
    } catch (error) {
      // Why: a resume that cannot be prepared must not cost the pane its shell.
      console.warn('[host-pane-resume] could not prepare the agent resume:', error)
      return null
    }
    // Why: the awaits above let the pane close, its session move to another pane, or another
    // activation start resuming it.
    const current = inputs.selectResume()
    const sessionKey = providerSessionKey(resume)
    if (
      !inputs.isStillPending() ||
      current?.agent !== resume.agent ||
      !agentProviderSessionsEqual(resume.agent, current.providerSession, resume.providerSession) ||
      this.resumingSessions.has(sessionKey)
    ) {
      return null
    }
    this.resumingSessions.add(sessionKey)
    return { launch, release: () => this.resumingSessions.delete(sessionKey) }
  }
}

/** The runtime state a pane re-creation reads to decide on a resume. */
export type HostPaneAgentResumeRuntime = {
  store: { getSettings: HostPaneAgentResumeInputs['getSettings'] } | null
  ptysById: ReadonlyMap<string, { connected: boolean; paneKey: string | null }>
  mobileSessionTabsByWorktree: ReadonlyMap<string, Pick<RuntimeMobileSessionTabsSnapshot, 'tabs'>>
  selectTerminalLossAgentResumeFn:
    | ((
        paneKey: string,
        isPaneTerminalLive: (paneKey: string) => boolean
      ) => TerminalLossAgentResume | null)
    | null
  getHostPaneAgentResumes: () => HostPaneAgentResumes
  resolveTerminalWorkspaceLaunchScope: (selector: string) => Promise<TerminalWorkspaceLaunchScope>
  getAgentLaunchPlatformForWorkspace: (scope: TerminalWorkspaceLaunchScope) => NodeJS.Platform
  markWorkspaceTrustedForAgent: (
    agent: TuiAgent,
    connectionId: string | null,
    workspacePath: string
  ) => Promise<void>
}

/** The resume launch for a pane whose terminal the host is re-creating, when its agent never ended. */
export function prepareHostPaneAgentResume(
  runtime: HostPaneAgentResumeRuntime,
  worktreeId: string,
  tab: RuntimeMobileSessionTerminalTab,
  sessionId: string | undefined
): Promise<PreparedHostPaneAgentResume | null> {
  const selectResume = runtime.selectTerminalLossAgentResumeFn
  const store = runtime.store
  if (!selectResume || !store) {
    return Promise.resolve(null)
  }
  const paneKey = makePaneKey(tab.parentTabId, tab.leafId)
  const isPaneTerminalLive = (candidate: string): boolean =>
    [...runtime.ptysById.values()].some((pty) => pty.connected && pty.paneKey === candidate)
  return runtime.getHostPaneAgentResumes().prepare({
    selectResume: () => selectResume(paneKey, isPaneTerminalLive),
    getSettings: () => store.getSettings(),
    resolveWorkspace: async () => {
      const workspace = await runtime.resolveTerminalWorkspaceLaunchScope(`id:${worktreeId}`)
      return {
        path: workspace.path,
        connectionId: workspace.connectionId,
        platform: runtime.getAgentLaunchPlatformForWorkspace(workspace)
      }
    },
    markWorkspaceTrusted: (agent, workspacePath) =>
      runtime.markWorkspaceTrustedForAgent(agent, null, workspacePath),
    isStillPending: () => {
      const current = runtime.mobileSessionTabsByWorktree
        .get(worktreeId)
        ?.tabs.find(
          (candidate): candidate is RuntimeMobileSessionTerminalTab =>
            candidate.type === 'terminal' &&
            candidate.parentTabId === tab.parentTabId &&
            candidate.leafId === tab.leafId
        )
      const currentSessionId =
        current?.ptyId ?? current?.parentLayout?.ptyIdsByLeafId?.[tab.leafId] ?? undefined
      return current !== undefined && currentSessionId === sessionId && !isPaneTerminalLive(paneKey)
    }
  })
}
