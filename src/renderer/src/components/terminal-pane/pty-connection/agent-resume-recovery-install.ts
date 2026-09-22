import { useAppStore } from '@/store'
import { fetchAgentResumeCandidates } from '@/lib/agent-resume-candidate-source'
import { recoverAgentSessionForPane } from '@/lib/agent-resume-recovery'
import { registerAgentResumePaneHandler } from '@/lib/agent-resume-pane-handlers'
import { setPendingAgentResumeChoices } from '@/lib/pending-agent-resume-choices'
import {
  agentResumeSessionsReservedElsewhere,
  reserveAgentResumeSession
} from '@/lib/agent-resume-session-reservations'
import { resolveAgentResumeLaunchTarget } from '@/lib/agent-resume-launch-target'
import type { AgentResumeCandidate } from '../../../../../shared/agent-resume-candidate'
import { isResumableTuiAgent } from '../../../../../shared/agent-session-resume'

import { buildCandidateResumeStartup } from './candidate-resume-startup'
import type { ConnectPanePtySession } from './connect-pane-pty-session'

/** Session ids a live pane already holds, plus the ones another pane has reserved but not yet
 *  spawned. Resuming one into a second pane would put two agents on one transcript. */
function claimedProviderSessionIds(
  state: ReturnType<typeof useAppStore.getState>,
  paneKey: string
): Set<string> {
  const claimed = agentResumeSessionsReservedElsewhere(paneKey)
  for (const entry of Object.values(state.agentStatusByPaneKey)) {
    if (entry.providerSession && entry.state !== 'done') {
      claimed.add(entry.providerSession.id)
    }
  }
  return claimed
}

export function installAgentResumeRecovery(session: ConnectPanePtySession): void {
  const bindingStillOwnsPane = (): boolean =>
    !session.disposed &&
    session.deps.paneTransportsRef.current.get(session.pane.id) === session.transport

  const resumeWithCandidate = (candidate: AgentResumeCandidate): boolean => {
    if (!bindingStillOwnsPane()) {
      return false
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
      return false
    }
    // Last step before the spawn, and synchronous: two panes that resolved the same sole
    // candidate while both scans were in flight cannot both get past this line.
    if (!reserveAgentResumeSession(candidate.providerSession.id, session.cacheKey)) {
      return false
    }
    void session.startFreshColdRestoreAgentResume(startup)
    return true
  }

  session.agentResumeRecoveryUnregister = registerAgentResumePaneHandler(
    session.cacheKey,
    resumeWithCandidate
  )

  session.attemptAgentResumeRecovery = async (): Promise<void> => {
    // Once per connection: a visibility flip must not re-ask the host, and a pane that already
    // declined a choice must not be offered it again on every tab switch.
    if (session.agentResumeRecoveryAttempted || !bindingStillOwnsPane()) {
      return
    }
    // Only the plain shell this connection just spawned may be replaced; a reattached PTY may
    // still be running the agent itself. Not latched: the spawn triggers its own attempt.
    if (!session.spawnedFreshPtyId) {
      return
    }
    // A hidden pane must not spend the latch: it retries when the user reveals it.
    if (!session.deps.isVisibleRef.current) {
      return
    }
    // Positive evidence THIS PANE hosted an agent. Never the tab-wide launch agent: it
    // describes the tab's original pty only (terminal-pane-close-identity.ts), so a plain-shell
    // split in an agent-launched tab would pass and have its shell destructively replaced.
    const paneAgent = session.resolvePaneScopedTuiAgent?.() ?? null
    if (!isResumableTuiAgent(paneAgent)) {
      return
    }
    const worktreePath = session.worktree?.path
    if (!worktreePath) {
      return
    }
    session.agentResumeRecoveryAttempted = true
    try {
      const action = await recoverAgentSessionForPane({
        paneKey: session.cacheKey,
        worktreePath,
        executionHostId: session.executionHostId,
        paneAgent,
        readPaneState: () => {
          const state = useAppStore.getState()
          return {
            paneHasOwnRecord: Boolean(session.getSleepingRecordForPane(state)),
            paneIsVisible: session.deps.isVisibleRef.current,
            // The same reading `isUntouchedFreshSpawnPty` uses: any input makes the shell theirs.
            paneHasReceivedInput: Number.isFinite(session.lastTerminalInputAt)
          }
        },
        readClaimedSessionIds: () =>
          claimedProviderSessionIds(useAppStore.getState(), session.cacheKey),
        fetchCandidates: (args) =>
          fetchAgentResumeCandidates({
            ...args,
            listSessions: (request) => window.api.aiVault.listSessions(request)
          }),
        resume: resumeWithCandidate,
        offerChoice: (paneKey, candidates) => {
          // A choice that arrives after the pane is gone would outlive it on the stable pane key.
          if (bindingStillOwnsPane()) {
            setPendingAgentResumeChoices(paneKey, candidates)
          }
        }
      })
      if (action.kind === 'none' && action.reason === 'scan-unverifiable') {
        // The host answered about nothing, so this pane has not had its attempt yet.
        session.agentResumeRecoveryAttempted = false
      }
    } catch (err) {
      // A relay that never answered is not evidence about this pane, so the attempt is retried
      // on the next reveal rather than disabled for the life of the connection.
      session.agentResumeRecoveryAttempted = false
      console.warn('[agent-resume] recovery attempt failed:', err)
    }
  }
}
