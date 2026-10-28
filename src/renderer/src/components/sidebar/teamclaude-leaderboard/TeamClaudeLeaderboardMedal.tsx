import { ArrowDown, ArrowUp, Trophy } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import {
  getTeamClaudeLeaderboardMedal,
  type TeamClaudeLeaderboardMedal,
  type TeamClaudeLeaderboardRankChange
} from './teamclaude-leaderboard-standing'

// Medal hues borrow existing gold, neutral and bronze tokens; the rank text carries the meaning.
const MEDAL_SURFACE_CLASS: Record<TeamClaudeLeaderboardMedal, string> = {
  gold: 'bg-status-warning/20',
  silver: 'bg-muted-foreground/20',
  bronze: 'bg-workspace-status-done/30'
}

const MEDAL_ICON_CLASS: Record<TeamClaudeLeaderboardMedal, string> = {
  gold: 'text-status-warning',
  silver: 'text-muted-foreground',
  bronze: 'text-workspace-status-done'
}

export function TeamClaudeLeaderboardTrophy({ rank }: { rank: number | null }): React.JSX.Element {
  const medal = rank === null ? null : getTeamClaudeLeaderboardMedal(rank)
  return (
    <span
      aria-hidden="true"
      className={cn(
        'grid size-6 shrink-0 place-items-center rounded-full',
        medal ? MEDAL_SURFACE_CLASS[medal] : 'text-muted-foreground'
      )}
    >
      <Trophy className={cn('size-3.5', medal && MEDAL_ICON_CLASS[medal])} />
    </span>
  )
}

export function TeamClaudeLeaderboardRankCell({ rank }: { rank: number }): React.JSX.Element {
  const medal = getTeamClaudeLeaderboardMedal(rank)
  return (
    <span
      className={cn(
        'grid size-4 place-items-center rounded-full text-3xs font-semibold tabular-nums',
        medal ? MEDAL_SURFACE_CLASS[medal] : 'text-muted-foreground'
      )}
    >
      {rank}
    </span>
  )
}

export function TeamClaudeLeaderboardRankChangeBadge({
  change
}: {
  change: TeamClaudeLeaderboardRankChange
}): React.JSX.Element {
  const up = change.direction === 'up'
  const places = Math.abs(change.from - change.to)
  const Arrow = up ? ArrowUp : ArrowDown
  return (
    <span
      // Remount per move so a second move replays the entrance.
      key={`${change.from}-${change.to}`}
      data-direction={change.direction}
      className={cn(
        'inline-flex shrink-0 items-center text-3xs font-semibold tabular-nums animate-in fade-in duration-500 motion-reduce:animate-none',
        up
          ? 'text-status-success slide-in-from-bottom-1'
          : 'text-muted-foreground slide-in-from-top-1'
      )}
    >
      <Arrow className="size-3" aria-hidden="true" />
      <span aria-hidden="true">{places}</span>
      <span className="sr-only">
        {up
          ? translate('teamclaudeLeaderboard.rankUp', 'Up from #{{rank}}', { rank: change.from })
          : translate('teamclaudeLeaderboard.rankDown', 'Down from #{{rank}}', {
              rank: change.from
            })}
      </span>
    </span>
  )
}
