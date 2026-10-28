import { CloudOff } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useNow } from '@/hooks/use-now'
import { translate } from '@/i18n/i18n'
import { formatUiRelativeTime } from '@/i18n/relative-time-format'
import { cn } from '@/lib/utils'
import { formatUsageTokens } from '@/components/stats/usage-overview-model'
import type { TeamClaudeLeaderboardEntry } from '../../../../../shared/teamclaude-leaderboard-types'
import { TeamClaudeLeaderboardRankCell } from './TeamClaudeLeaderboardMedal'
import type { TeamClaudeLeaderboardOkSnapshot } from './teamclaude-leaderboard-standing'

const READ_TIME_TICK_MS = 30_000
const BOARD_GRID_CLASS =
  'grid grid-cols-[1rem_minmax(0,1fr)_2.75rem_2.75rem] items-center gap-x-1.5'

function LeaderboardRow({ entry }: { entry: TeamClaudeLeaderboardEntry }): React.JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div
          role="row"
          tabIndex={0}
          data-current={entry.isSelf ? 'true' : undefined}
          className={cn(
            BOARD_GRID_CLASS,
            'rounded-md px-1.5 py-0.5 text-xs outline-none hover:bg-worktree-sidebar-accent focus-visible:ring-[3px] focus-visible:ring-worktree-sidebar-ring/50',
            entry.isSelf &&
              'bg-worktree-sidebar-accent font-medium text-worktree-sidebar-accent-foreground'
          )}
        >
          <span role="cell">
            <TeamClaudeLeaderboardRankCell rank={entry.rank} />
          </span>
          <span role="cell" className="truncate">
            {entry.person}
          </span>
          <span role="cell" className="text-right tabular-nums">
            {formatUsageTokens(entry.tokens)}
          </span>
          <span role="cell" className="text-right tabular-nums text-muted-foreground">
            {formatUsageTokens(entry.outputTokens)}
          </span>
        </div>
      </TooltipTrigger>
      <TooltipContent side="right" sideOffset={8} className="max-w-64">
        {entry.clients.map((client) => (
          <div key={client} className="break-all">
            {client}
          </div>
        ))}
        <div className="opacity-70">
          {translate(
            'teamclaudeLeaderboard.rawTotal',
            '{{tokens}} raw tokens, cache reads included',
            { tokens: formatUsageTokens(entry.totalTokens) }
          )}
        </div>
      </TooltipContent>
    </Tooltip>
  )
}

function ReadTimeFooter({
  fetchedAt,
  staleSince
}: {
  fetchedAt: number
  staleSince: number | null
}): React.JSX.Element {
  const now = useNow(READ_TIME_TICK_MS)
  // Why: a host clock ahead of this one must not render a future read.
  const updated = translate('teamclaudeLeaderboard.updated', 'Updated {{age}}', {
    age: formatUiRelativeTime(Math.min(0, fetchedAt - now))
  })
  return (
    <div
      data-stale={staleSince === null ? undefined : 'true'}
      className="flex min-w-0 items-center gap-1 px-1.5 pt-1 text-3xs text-muted-foreground"
    >
      {staleSince === null ? null : (
        <>
          <CloudOff className="size-3 shrink-0 text-status-warning" aria-hidden="true" />
          <span className="shrink-0 font-medium">
            {translate('teamclaudeLeaderboard.stale', 'Stale')}
          </span>
          <span aria-hidden="true">·</span>
        </>
      )}
      <span className="truncate">{updated}</span>
    </div>
  )
}

export function TeamClaudeLeaderboardBoard({
  snapshot,
  staleSince
}: {
  snapshot: TeamClaudeLeaderboardOkSnapshot
  staleSince: number | null
}): React.JSX.Element {
  return (
    <div className="pb-1 pt-1.5">
      <div className="px-1.5 pb-1 text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
        {translate('teamclaudeLeaderboard.title', 'TeamClaude today')}
      </div>
      {snapshot.entries.length === 0 ? (
        <div className="px-1.5 py-1 text-xs text-muted-foreground">
          {translate('teamclaudeLeaderboard.empty', 'No usage today yet')}
        </div>
      ) : (
        <div
          role="table"
          aria-label={translate('teamclaudeLeaderboard.ariaLabel', 'TeamClaude leaderboard')}
        >
          <div
            role="row"
            className={cn(
              BOARD_GRID_CLASS,
              'px-1.5 pb-0.5 text-3xs uppercase tracking-wider text-muted-foreground'
            )}
          >
            <span role="columnheader">#</span>
            <span role="columnheader" className="truncate">
              {translate('teamclaudeLeaderboard.person', 'Person')}
            </span>
            <span role="columnheader" className="truncate text-right">
              {translate('teamclaudeLeaderboard.freshTokens', 'Fresh')}
            </span>
            <span role="columnheader" className="truncate text-right">
              {translate('teamclaudeLeaderboard.outputTokens', 'Output')}
            </span>
          </div>
          <div role="rowgroup" className="worktree-sidebar-scrollbar max-h-56 overflow-y-auto">
            {snapshot.entries.map((entry) => (
              <LeaderboardRow key={entry.person} entry={entry} />
            ))}
          </div>
        </div>
      )}
      <ReadTimeFooter fetchedAt={snapshot.fetchedAt} staleSince={staleSince} />
    </div>
  )
}
