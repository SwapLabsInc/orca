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
import { paneAgentResumeScopePath } from '@/lib/agent-resume-workspace-scope'
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

/** Refusals that mean "we never got an answer", so the pane keeps its one attempt. Every other
 *  refusal is a real verdict about this pane and stays spent. */
const UNSPENT_AGENT_RESUME_REFUSALS: ReadonlySet<string> = new Set([
  // The host scan was cancelled, partial, truncated or unreachable.
  'scan-unverifiable',
  // The contract is that a hidden pane does not spend its attempt and retries when revealed. The
  // pre-scan return below covers a pane hidden at the start; the ~2s scan is long enough for the
  // user to switch away inside it, and the post-scan gate answers `pane-hidden` for that too.
  'pane-hidden'
])

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
      worktreePath: paneAgentResumeScopePath({
        worktreePath: session.worktree?.path,
        folderWorkspacePath: session.folderWorkspace?.folderPath
      }),
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
    // EP-STATE: revalidate the identity that authorized this candidate, immediately before the
    // spawn and in one synchronous step with the claim. The chooser's rows were scanned seconds
    // ago, and the renderer-local reservation map is not the only way a candidate goes live —
    // another pane's cold restore and an Agent Session History launch both reserve nothing here,
    // so the host-owned status store is the evidence that settles it.
    if (
      claimedProviderSessionIds(useAppStore.getState(), session.cacheKey).has(
        candidate.providerSession.id
      ) ||
      // Two panes that resolved the same sole candidate while both scans were in flight cannot
      // both get past this line.
      !reserveAgentResumeSession(candidate.providerSession.id, session.cacheKey)
    ) {
      return false
    }
    void session.startFreshColdRestoreAgentResume(startup)
    return true
  }

  session.agentResumeRecoveryUnregister = registerAgentResumePaneHandler(
    session.cacheKey,
    session.transport,
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
    const worktreePath = paneAgentResumeScopePath({
      worktreePath: session.worktree?.path,
      folderWorkspacePath: session.folderWorkspace?.folderPath
    })
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
            setPendingAgentResumeChoices(paneKey, session.transport, candidates)
          }
        }
      })
      if (action.kind === 'none' && UNSPENT_AGENT_RESUME_REFUSALS.has(action.reason)) {
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
