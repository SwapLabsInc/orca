/** How often the runtime host rereads the coordinator and the sidebar polls; the status payload is several MB. */
export const TEAMCLAUDE_LEADERBOARD_REFRESH_MS = 60_000

export type TeamClaudeLeaderboardEntry = {
  /** `minidev-<person><n>` clients fold into one person; other client names stand alone. */
  person: string
  clients: string[]
  /** 1-based; equal token counts share a rank. */
  rank: number
  isSelf: boolean
  /** Input, output and cache-write tokens; cache reads (most of the raw total) are excluded. */
  tokens: number
  outputTokens: number
  /** TeamClaude's raw total, cache reads included. */
  totalTokens: number
  requests: number
}

export type TeamClaudeLeaderboardSnapshot =
  | {
      status: 'ok'
      window: '1d'
      /** Epoch ms of the coordinator read these entries came from. */
      fetchedAt: number
      /** Epoch ms of the first failed refresh since `fetchedAt`; null while fresh. */
      staleSince: number | null
      entries: TeamClaudeLeaderboardEntry[]
      /** Null when this host's person has no usage in the window. */
      self: { person: string; rank: number; of: number } | null
    }
  /** The runtime host has no TeamClaude wrapper install, so the section stays hidden. */
  | { status: 'not-configured' }
  /** Configured, but no coordinator read has succeeded yet. */
  | { status: 'unavailable'; message: string }
