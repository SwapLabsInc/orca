import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import type { TeamClaudeLeaderboardSnapshot } from '../../../shared/teamclaude-leaderboard-types'

/** Null when the target runtime does not serve the leaderboard, e.g. an older or upstream build. */
export async function getTeamClaudeLeaderboard(
  _target: RuntimeClientTarget
): Promise<TeamClaudeLeaderboardSnapshot | null> {
  return null
}
