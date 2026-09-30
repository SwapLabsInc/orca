// The relay half of a user-ended Claude session: `SessionEnd` yields no status row, so the relay
// forwards it as its own notice for the host to read as the local listener reads the raw hook.
import { parseHookEnvelope } from '../shared/agent-hook-listener/hook-envelope'
import type { HookListenerState } from '../shared/agent-hook-listener/listener-state'
import { readClaudeUserEndedSessionId } from '../shared/agent-hook-listener/providers/claude-session-end'
import {
  AGENT_HOOK_USER_ENDED_SESSION_STATE,
  type AgentHookRelayEnvelope,
  type AgentHookRelayUserEndedSessionEnvelope,
  type AgentHookSource
} from '../shared/agent-hook-relay'
import { hookBodyEnv, hookBodyVersion } from './agent-hook-envelope-build'

export type RelayUserEndedSessionForward = (
  envelope: AgentHookRelayUserEndedSessionEnvelope
) => void

type RelayHookServerView = {
  state: HookListenerState
  env: string
  isPaneSurfaceRetired: (paneKey: string) => boolean
  clearPaneState: (paneKey: string) => void
}

/** The notice for a hook that says the user ended its Claude session, or null for any other hook. */
export function buildRelayUserEndedSessionEnvelope(
  state: HookListenerState,
  source: AgentHookSource,
  body: unknown,
  listenerEnv: string,
  isReplay: boolean
): AgentHookRelayUserEndedSessionEnvelope | null {
  if (source !== 'claude') {
    return null
  }
  const envelope = parseHookEnvelope(state, 'claude', body, listenerEnv)
  const sessionId = envelope ? readClaudeUserEndedSessionId(envelope) : null
  if (!envelope || !sessionId) {
    return null
  }
  return {
    source: 'claude',
    paneKey: envelope.paneKey,
    ...(envelope.launchToken ? { launchToken: envelope.launchToken } : {}),
    connectionId: null,
    hookEventName: 'SessionEnd',
    userEndedSessionId: sessionId,
    reportsUserEndedSessions: true,
    ...(isReplay ? { isReplay: true } : {}),
    env: hookBodyEnv(body),
    version: hookBodyVersion(body),
    payload: { state: AGENT_HOOK_USER_ENDED_SESSION_STATE }
  }
}

/** Whether the pane's cached row belongs to the process that ended, so replaying it after a
 *  reconnect would bring the ended session back. A nested CLI's own session never matches. */
export function isCachedRowOfEndedSession(
  state: HookListenerState,
  notice: AgentHookRelayUserEndedSessionEnvelope
): boolean {
  const cached = state.lastStatusByPaneKey.get(notice.paneKey)
  if (cached?.providerSession?.id !== notice.userEndedSessionId) {
    return false
  }
  const cachedToken = cached.launchToken?.trim()
  const endedToken = notice.launchToken?.trim()
  return !cachedToken || !endedToken || cachedToken === endedToken
}

/** Forwards the Claude sessions users end, for a relay whose host resumes its panes (WSL). */
export class RelayUserEndedSessionReporter {
  constructor(
    private readonly forward: RelayUserEndedSessionForward,
    private readonly server: RelayHookServerView
  ) {}

  /** Stamps every status envelope: only a relay that reports user-ended sessions proves its rows'
   *  agents were not quit, so only its rows may be resumed after a terminal is lost. */
  stampEach(
    forward: (envelope: AgentHookRelayEnvelope) => void
  ): (envelope: AgentHookRelayEnvelope) => void {
    return (envelope) => forward({ ...envelope, reportsUserEndedSessions: true })
  }

  /** Forwards a hook that says the user ended its Claude session; ignores any other hook. */
  report(source: AgentHookSource, body: unknown, isReplay = false): void {
    const { state, env, isPaneSurfaceRetired, clearPaneState } = this.server
    const notice = buildRelayUserEndedSessionEnvelope(state, source, body, env, isReplay)
    if (!notice || isPaneSurfaceRetired(notice.paneKey)) {
      return
    }
    // Why: replaying the ended process's cached row after a reconnect would make it resumable again.
    if (isCachedRowOfEndedSession(state, notice)) {
      clearPaneState(notice.paneKey)
    }
    this.forward(notice)
  }
}
