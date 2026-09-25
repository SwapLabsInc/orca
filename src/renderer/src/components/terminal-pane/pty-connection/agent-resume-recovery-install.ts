import { useAppStore } from '@/store'
import { fetchAgentResumeCandidates } from '@/lib/agent-resume-candidate-source'
import { recoverAgentSessionForPane } from '@/lib/agent-resume-recovery'
import { agentResumeSessionsClaimedByOtherPanes } from '@/lib/agent-resume-session-claims'
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

/** Session ids another pane holds under THE PANE-IDENTITY CLAIM RULE, plus the ones another pane
 *  has reserved but not yet spawned. Resuming one into a second pane would put two agents on one
 *  transcript. */
function claimedProviderSessionIds(
  state: ReturnType<typeof useAppStore.getState>,
  paneKey: string
): Set<string> {
  const claimed = agentResumeSessionsReservedElsewhere(paneKey)
  for (const sessionId of agentResumeSessionsClaimedByOtherPanes(state, paneKey)) {
    claimed.add(sessionId)
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
      tabShellOverride: session.shellOverride,
      hostPlatform: candidate.executionHostPlatform
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
    // The plain shell this connection just spawned still owns the pane's stable key, so a bare
    // connect would REATTACH it instead of running the resume command: recovery would report
    // success, close the chooser, and leave the same shell. reattach-result-handler only retires
    // an adopted shell for a passive sleeping-record restore, and this startup has no record by
    // design — so retire the binding here, the way that path does.
    session.transport.disconnect()
    const retiredPtyId = session.spawnedFreshPtyId
    if (retiredPtyId) {
      session.clearExitedPanePtyLayoutBinding(retiredPtyId)
      session.deps.clearTabPtyId(session.deps.tabId, retiredPtyId)
    } else {
      session.syncPanePtyLayoutBinding(null)
    }
    // Held so disposal can tell "reserved, spawn still settling" from "reserved and claimed".
    // Releasing in that window frees a transcript a sibling pane can then respawn.
    const spawned = Promise.resolve(session.startFreshColdRestoreAgentResume(startup)).catch(
      () => undefined
    )
    session.agentResumeSpawnInFlight = spawned
    void spawned.finally(() => {
      if (session.agentResumeSpawnInFlight === spawned) {
        session.agentResumeSpawnInFlight = null
      }
    })
    return true
  }

  session.agentResumeRecoveryUnregister = registerAgentResumePaneHandler(
    session.cacheKey,
    session.transport,
    resumeWithCandidate
  )

  // One shot: it re-arms from the same gate if the next attempt still finds no evidence, and the
  // latch makes a late fire a no-op. Hidden panes and unreachable hosts keep their own retries.
  const watchForPaneAgentEvidence = (): void => {
    if (session.agentResumeRecoveryStatusUnsubscribe) {
      return
    }
    session.agentResumeRecoveryStatusUnsubscribe = useAppStore.subscribe(() => {
      if (session.agentResumeRecoveryAttempted || !bindingStillOwnsPane()) {
        return
      }
      if (!isResumableTuiAgent(session.resolvePaneScopedTuiAgent?.() ?? null)) {
        return
      }
      session.agentResumeRecoveryStatusUnsubscribe?.()
      session.agentResumeRecoveryStatusUnsubscribe = null
      void session.attemptAgentResumeRecovery?.()
    })
  }

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
    // This pane was opened to run something specific, so its launchAgent names what the user just
    // asked for — not a conversation that went missing. Recovery starts before the startup is
    // delivered and automatic delivery records no input, so a scan finishing later would replace
    // the requested agent with an older transcript. Latched: the request stands for this
    // connection even after the command has been delivered and cleared.
    if (session.paneStartup?.command) {
      session.agentResumeRecoveryAttempted = true
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
      // A restored pane's only pane-scoped evidence can be the hook server's persisted status,
      // which lands after onPtySpawn has already run this gate. An already-visible pane gets no
      // later visibility flip, so without a watch it sits as a plain shell until the user
      // switches away and back. Armed here rather than at install so only a pane actually
      // waiting on hydration carries a subscription.
      watchForPaneAgentEvidence()
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
            // Keystrokes, IME and paste only: a mouse report, a focus report or an xterm query reply
            // reaches the shell without the user claiming it (`isUntouchedFreshSpawnPty` still
            // counts those). Without xterm's provenance signal every accepted write counts.
            paneHasReceivedInput: Number.isFinite(
              session.userInputActivityDisposable === null
                ? session.lastTerminalInputAt
                : session.lastRealUserInputAt
            )
          }
        },
        // The pane's own row, from the host-owned status store — never the tab's.
        readPaneProviderSessionId: () =>
          useAppStore.getState().agentStatusByPaneKey[session.cacheKey]?.providerSession?.id ??
          null,
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
