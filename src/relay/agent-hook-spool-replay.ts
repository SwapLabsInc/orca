import { isAgentHookSource, type AgentHookSource } from '../shared/agent-hook-relay'
import { buildSpoolHookBody, drainAgentHookSpool } from '../shared/agent-hook-spool'

/** Replays the hooks agent CLIs spooled while no relay listened, oldest first. */
export function replayRelayHookSpool(
  endpointDir: string,
  ingest: (source: AgentHookSource, body: unknown) => void
): void {
  try {
    drainAgentHookSpool({
      endpointDir,
      getPersistedLaunchTokenHash: () => undefined,
      ingest: (record) => {
        if (isAgentHookSource(record.source)) {
          ingest(record.source, buildSpoolHookBody(record))
        }
      }
    })
  } catch (err) {
    // Why: a downstream relay failure must not prevent the loopback listener from starting;
    // the untruncated spool file remains available for retry on the next restart.
    process.stderr.write(
      `[relay-hook-server] spool replay failed: ${err instanceof Error ? err.message : String(err)}\n`
    )
  }
}
