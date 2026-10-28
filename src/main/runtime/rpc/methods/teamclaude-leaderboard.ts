import { defineMethod } from '../core'
import { getTeamClaudeLeaderboard } from '../../../teamclaude-leaderboard/teamclaude-leaderboard-service'

// Fork-local and read-only: this host's aggregated board, never the coordinator payload or its key.
export const TEAMCLAUDE_LEADERBOARD_METHODS = [
  defineMethod({
    name: 'teamclaude.leaderboard',
    permission: 'workspace',
    params: null,
    handler: async () => getTeamClaudeLeaderboard()
  })
]
