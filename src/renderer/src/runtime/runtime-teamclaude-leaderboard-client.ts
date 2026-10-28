import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import type { TeamClaudeLeaderboardSnapshot } from '../../../shared/teamclaude-leaderboard-types'
import { hasRuntimeRpcErrorCode } from '../../../shared/runtime-rpc-error-code'
import { callRuntimeRpc } from './runtime-rpc-client'

// The host's own read is bounded at 10 s; leave room for the paired-runtime hop.
const LEADERBOARD_RPC_TIMEOUT_MS = 15_000
const KNOWN_STATUSES: readonly unknown[] = ['ok', 'not-configured', 'unavailable']

// A newer runtime's unknown status stays hidden rather than rendering as a board.
function hasKnownStatus(value: unknown): value is TeamClaudeLeaderboardSnapshot {
  return (
    typeof value === 'object' &&
    value !== null &&
    'status' in value &&
    KNOWN_STATUSES.includes(value.status)
  )
}

/** Null when the target runtime does not serve the leaderboard, e.g. an older or upstream build. */
export async function getTeamClaudeLeaderboard(
  target: RuntimeClientTarget
): Promise<TeamClaudeLeaderboardSnapshot | null> {
  let result: unknown
  try {
    result = await callRuntimeRpc<unknown>(target, 'teamclaude.leaderboard', undefined, {
      timeoutMs: LEADERBOARD_RPC_TIMEOUT_MS
    })
  } catch (error) {
    // Upstream and older fork runtimes lack the method; scoped callers such as phones are refused it.
    if (
      hasRuntimeRpcErrorCode(error, 'method_not_found') ||
      hasRuntimeRpcErrorCode(error, 'forbidden')
    ) {
      return null
    }
    throw error
  }
  return hasKnownStatus(result) ? result : null
}
