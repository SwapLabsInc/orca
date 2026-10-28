import type {
  TeamClaudeLeaderboardEntry,
  TeamClaudeLeaderboardSnapshot
} from '../../../../../shared/teamclaude-leaderboard-types'

export type TeamClaudeLeaderboardOkSnapshot = Extract<
  TeamClaudeLeaderboardSnapshot,
  { status: 'ok' }
>

export type TeamClaudeLeaderboardMedal = 'gold' | 'silver' | 'bronze'

export type TeamClaudeLeaderboardGap =
  | { kind: 'leading'; tokens: number }
  | { kind: 'behind'; tokens: number; rank: number }
  | { kind: 'tied'; rank: number }

export type TeamClaudeLeaderboardRankChange = { direction: 'up' | 'down'; from: number; to: number }

export function getTeamClaudeLeaderboardMedal(rank: number): TeamClaudeLeaderboardMedal | null {
  return rank === 1 ? 'gold' : rank === 2 ? 'silver' : rank === 3 ? 'bronze' : null
}

export function getTeamClaudeLeaderboardSelfEntry(
  snapshot: TeamClaudeLeaderboardOkSnapshot
): TeamClaudeLeaderboardEntry | null {
  return snapshot.entries.find((entry) => entry.isSelf) ?? null
}

/** Distance to the nearest rank above, or the lead over the nearest rank below for #1. */
export function getTeamClaudeLeaderboardGap(
  entries: readonly TeamClaudeLeaderboardEntry[],
  self: TeamClaudeLeaderboardEntry
): TeamClaudeLeaderboardGap | null {
  let above: TeamClaudeLeaderboardEntry | null = null
  let below: TeamClaudeLeaderboardEntry | null = null
  let tied = false
  for (const entry of entries) {
    if (entry === self) {
      continue
    }
    if (entry.tokens > self.tokens) {
      if (!above || entry.tokens < above.tokens) {
        above = entry
      }
    } else if (entry.tokens < self.tokens) {
      if (!below || entry.tokens > below.tokens) {
        below = entry
      }
    } else {
      tied = true
    }
  }
  if (above) {
    return { kind: 'behind', tokens: above.tokens - self.tokens, rank: above.rank }
  }
  if (tied) {
    return { kind: 'tied', rank: self.rank }
  }
  return below ? { kind: 'leading', tokens: self.tokens - below.tokens } : null
}

/** Only the same person's rank on consecutive reads counts as a move. */
export function getTeamClaudeLeaderboardRankChange(
  previous: TeamClaudeLeaderboardOkSnapshot['self'],
  next: TeamClaudeLeaderboardOkSnapshot['self']
): TeamClaudeLeaderboardRankChange | null {
  if (!previous || !next || previous.person !== next.person || previous.rank === next.rank) {
    return null
  }
  return {
    direction: next.rank < previous.rank ? 'up' : 'down',
    from: previous.rank,
    to: next.rank
  }
}
