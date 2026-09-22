import { useAppStore } from '@/store'
import { fetchAgentResumeCandidates } from '@/lib/agent-resume-candidate-source'
import { recoverAgentSessionForPane } from '@/lib/agent-resume-recovery'
import { registerAgentResumePaneHandler } from '@/lib/agent-resume-pane-handlers'
import { setPendingAgentResumeChoices } from '@/lib/pending-agent-resume-choices'
import { resolveAgentResumeLaunchTarget } from '@/lib/agent-resume-launch-target'
import type { AgentResumeCandidate } from '../../../../../shared/agent-resume-candidate'

import { buildCandidateResumeStartup } from './candidate-resume-startup'
import type { ConnectPanePtySession } from './connect-pane-pty-session'

/** Session ids a live pane already holds. Resuming one into a second pane would put two
 *  agents on one transcript, so they are excluded before anything is offered. */
function claimedProviderSessionIds(state: ReturnType<typeof useAppStore.getState>): Set<string> {
  const claimed = new Set<string>()
  for (const entry of Object.values(state.agentStatusByPaneKey)) {
    if (entry.providerSession && entry.state !== 'done') {
      claimed.add(entry.providerSession.id)
    }
  }
  return claimed
}

export function installAgentResumeRecovery(session: ConnectPanePtySession): void {
  const resumeWithCandidate = (candidate: AgentResumeCandidate): void => {
    if (session.disposed) {
      return
    }
    const state = useAppStore.getState()
    const target = resolveAgentResumeLaunchTarget({
      projectRuntime: session.projectRuntime,
      connectionId: session.connectionId,
      executionHostId: session.executionHostId,
      worktreePath: session.worktree?.path,
      terminalWindowsShell: state.settings?.terminalWindowsShell,
      tabShellOverride: session.shellOverride
    })
    const startup = buildCandidateResumeStartup({
      candidate,
      cmdOverrides: state.settings?.agentCmdOverrides ?? {},
      agentDefaultArgs: state.settings?.agentDefaultArgs,
      agentDefaultEnv: state.settings?.agentDefaultEnv,
      platform: target.platform,
      shell: target.shell
    })
    if (!startup) {
      return
    }
    void session.startFreshColdRestoreAgentResume(startup)
  }

  session.agentResumeRecoveryUnregister = registerAgentResumePaneHandler(
    session.cacheKey,
    resumeWithCandidate
  )

  session.attemptAgentResumeRecovery = async (): Promise<void> => {
    // Once per connection: a visibility flip must not re-ask the host, and a pane that already
    // declined a choice must not be offered it again on every tab switch.
    if (session.agentResumeRecoveryAttempted || session.disposed) {
      return
    }
    session.agentResumeRecoveryAttempted = true
    const worktreePath = session.worktree?.path
    if (!worktreePath) {
      return
    }
    await recoverAgentSessionForPane({
      paneKey: session.cacheKey,
      worktreePath,
      executionHostId: session.executionHostId,
      paneAgent: session.startupDraftAgent ?? null,
      readPaneState: () => {
        const state = useAppStore.getState()
        return {
          paneHasOwnRecord: Boolean(session.getSleepingRecordForPane(state)),
          paneIsVisible: session.deps.isVisibleRef.current,
          // The same reading `isUntouchedFreshSpawnPty` uses: any input makes the shell theirs.
          paneHasReceivedInput: Number.isFinite(session.lastTerminalInputAt)
        }
      },
      claimedSessionIds: claimedProviderSessionIds(useAppStore.getState()),
      fetchCandidates: (args) =>
        fetchAgentResumeCandidates({
          ...args,
          listSessions: (request) => window.api.aiVault.listSessions(request)
        }),
      resume: resumeWithCandidate,
      offerChoice: setPendingAgentResumeChoices
    })
  }
}
