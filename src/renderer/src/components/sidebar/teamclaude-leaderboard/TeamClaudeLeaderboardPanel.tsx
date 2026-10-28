import { ChevronUp, CloudOff } from 'lucide-react'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { formatUsageTokens } from '@/components/stats/usage-overview-model'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import { TeamClaudeLeaderboardBoard } from './TeamClaudeLeaderboardBoard'
import {
  TeamClaudeLeaderboardRankChangeBadge,
  TeamClaudeLeaderboardTrophy
} from './TeamClaudeLeaderboardMedal'
import {
  getTeamClaudeLeaderboardGap,
  getTeamClaudeLeaderboardSelfEntry,
  type TeamClaudeLeaderboardGap
} from './teamclaude-leaderboard-standing'
import type { TeamClaudeLeaderboardView } from './use-teamclaude-leaderboard'

type VisibleView = Exclude<TeamClaudeLeaderboardView, { kind: 'hidden' }>
type OkView = Extract<TeamClaudeLeaderboardView, { kind: 'ok' }>

const SECTION_CLASS = 'shrink-0 border-t border-worktree-sidebar-border px-2 py-1'

function sectionLabel(): string {
  return translate('teamclaudeLeaderboard.ariaLabel', 'TeamClaude leaderboard')
}

function gapLabel(gap: TeamClaudeLeaderboardGap): string {
  switch (gap.kind) {
    case 'leading':
      return translate('teamclaudeLeaderboard.ahead', '{{tokens}} ahead', {
        tokens: formatUsageTokens(gap.tokens)
      })
    case 'behind':
      return translate('teamclaudeLeaderboard.behind', '{{tokens}} behind #{{rank}}', {
        tokens: formatUsageTokens(gap.tokens),
        rank: gap.rank
      })
    case 'tied':
      return translate('teamclaudeLeaderboard.tied', 'tied for #{{rank}}', { rank: gap.rank })
  }
}

function standingLines(view: OkView): { headline: string; detail: string | null } {
  const { snapshot } = view
  if (!snapshot.self) {
    const leader = snapshot.entries[0]
    return {
      headline: translate('teamclaudeLeaderboard.notRanked', 'No usage today'),
      detail: leader
        ? translate('teamclaudeLeaderboard.leader', '{{person}} leads with {{tokens}}', {
            person: leader.person,
            tokens: formatUsageTokens(leader.tokens)
          })
        : null
    }
  }
  const headline = translate('teamclaudeLeaderboard.rank', '#{{rank}} of {{of}} today', {
    rank: snapshot.self.rank,
    of: snapshot.self.of
  })
  const selfEntry = getTeamClaudeLeaderboardSelfEntry(snapshot)
  if (!selfEntry) {
    return { headline, detail: null }
  }
  const tokens = translate('teamclaudeLeaderboard.selfTokens', '{{tokens}} tokens', {
    tokens: formatUsageTokens(selfEntry.tokens)
  })
  const gap = getTeamClaudeLeaderboardGap(snapshot.entries, selfEntry)
  return { headline, detail: gap ? `${tokens} · ${gapLabel(gap)}` : tokens }
}

function UnavailableLine({ message }: { message: string }): React.JSX.Element {
  return (
    <section aria-label={sectionLabel()} className={SECTION_CLASS}>
      <div
        data-teamclaude-leaderboard="unavailable"
        className="flex min-w-0 items-start gap-2 px-1 py-0.5 text-2xs text-muted-foreground"
      >
        <TeamClaudeLeaderboardTrophy rank={null} />
        <span className="min-w-0">
          <span className="block truncate">
            {translate('teamclaudeLeaderboard.unavailable', 'Leaderboard unavailable')}
          </span>
          <span className="block break-words text-3xs">{message}</span>
        </span>
      </div>
    </section>
  )
}

export function TeamClaudeLeaderboardPanel({
  view,
  expanded,
  onExpandedChange
}: {
  view: VisibleView
  expanded: boolean
  onExpandedChange: (expanded: boolean) => void
}): React.JSX.Element {
  if (view.kind === 'unavailable') {
    return <UnavailableLine message={view.message} />
  }
  const { headline, detail } = standingLines(view)
  const stale = view.staleSince !== null
  return (
    <section aria-label={sectionLabel()} className={SECTION_CLASS}>
      <Collapsible open={expanded} onOpenChange={onExpandedChange}>
        {/* Opens upward so the row stays put above the toolbar. */}
        <CollapsibleContent animation="height">
          <TeamClaudeLeaderboardBoard snapshot={view.snapshot} staleSince={view.staleSince} />
        </CollapsibleContent>
        <CollapsibleTrigger asChild>
          <button
            type="button"
            data-teamclaude-leaderboard="row"
            className="flex w-full min-w-0 items-center gap-2 rounded-md px-1 py-0.5 text-left outline-none transition-colors hover:bg-worktree-sidebar-accent hover:text-worktree-sidebar-accent-foreground focus-visible:ring-[3px] focus-visible:ring-worktree-sidebar-ring/50"
          >
            <TeamClaudeLeaderboardTrophy rank={view.snapshot.self?.rank ?? null} />
            <span className="min-w-0 flex-1">
              <span className="flex min-w-0 items-center gap-1">
                <span className="truncate text-xs font-medium">{headline}</span>
                {view.rankChange ? (
                  <TeamClaudeLeaderboardRankChangeBadge change={view.rankChange} />
                ) : null}
                {stale ? (
                  <>
                    <CloudOff className="size-3 shrink-0 text-status-warning" aria-hidden="true" />
                    <span className="sr-only">
                      {translate('teamclaudeLeaderboard.stale', 'Stale')}
                    </span>
                  </>
                ) : null}
              </span>
              {detail ? (
                <span className="block truncate text-2xs tabular-nums text-muted-foreground">
                  {detail}
                </span>
              ) : null}
            </span>
            <ChevronUp
              aria-hidden="true"
              className={cn(
                'size-3.5 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none',
                expanded && 'rotate-180'
              )}
            />
          </button>
        </CollapsibleTrigger>
      </Collapsible>
    </section>
  )
}
