// SwapLabs fork (#30): the relay hook server's part in reporting the Claude sessions users end,
// for a relay whose host resumes its panes (WSL).
import { RelayAgentHookCanonicalStatus } from './agent-hook-canonical-status'
import type { RelayHookForward, RelayHookServerOptions } from './agent-hook-server-contract'
import { drainRelayHookSpool } from './agent-hook-spool-ingest'
import {
  reportUserEndedSessions,
  type RelayUserEndedSessionReporter
} from './agent-hook-user-ended-session'

export class RelayAgentHookUserEndedSessionServer extends RelayAgentHookCanonicalStatus {
  protected userEndedSessions: RelayUserEndedSessionReporter | undefined

  /** Starts reporting user-ended sessions when the relay forwards them, and returns the status
   *  forward, stamped then so the host knows this relay's rows can prove their agents were not quit. */
  protected forwardReportingUserEndedSessions(
    options: RelayHookServerOptions,
    server: Parameters<typeof reportUserEndedSessions>[1]
  ): RelayHookForward {
    this.userEndedSessions = reportUserEndedSessions(options, server)
    return this.userEndedSessions?.stampEach(options.forward) ?? options.forward
  }

  /** Replays the hook spool, reading each record for a session its user ended. */
  protected drainReportingHookSpool(
    ...[endpointDir, state, env, hostOf]: Parameters<typeof drainRelayHookSpool>
  ): Promise<void> {
    return drainRelayHookSpool(endpointDir, state, env, (record) => ({
      ...hostOf(record),
      userEndedSessions: this.userEndedSessions
    }))
  }
}
