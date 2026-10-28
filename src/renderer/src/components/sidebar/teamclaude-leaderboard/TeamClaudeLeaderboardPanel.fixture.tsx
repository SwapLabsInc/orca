import { useState } from 'react'
import { defineFixture } from '../../../component-fixtures/component-fixture'
import type { TeamClaudeLeaderboardEntry } from '../../../../../shared/teamclaude-leaderboard-types'
import { TeamClaudeLeaderboardPanel } from './TeamClaudeLeaderboardPanel'
import type { TeamClaudeLeaderboardRankChange } from './teamclaude-leaderboard-standing'
import type { TeamClaudeLeaderboardView } from './use-teamclaude-leaderboard'

// The fixture frame pads 16px per side; these widths frame the sidebar's default and minimum.
const FRAME_PADDING = 32
const SIDEBAR_WIDTH = 280 + FRAME_PADDING
const SIDEBAR_MIN_WIDTH = 220 + FRAME_PADDING
// Lets the rank-change entrance finish before the shot.
const SETTLE_ANIMATION = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 700))

const CLIENTS: Record<string, string[]> = {
  alex: ['minidev-alex1', 'minidev-alex2', 'minidev-alex3'],
  brooke: ['minidev-brooke1', 'minidev-brooke2'],
  chen: ['minidev-chen1'],
  dana: ['minidev-dana1'],
  eli: ['minidev-eli1'],
  'ci-runner': ['ci-runner']
}
// Fresh and output tokens by board position.
const POSITION_TOKENS: readonly [number, number][] = [
  [61_400_000, 9_800_000],
  [48_900_000, 7_100_000],
  [42_300_000, 6_200_000],
  [30_100_000, 4_400_000],
  [12_700_000, 1_900_000],
  [3_200_000, 400_000]
]

function board(selfPerson: string, order: readonly string[]): TeamClaudeLeaderboardEntry[] {
  return order.map((person, index) => {
    const [tokens, outputTokens] = POSITION_TOKENS[index]
    return {
      person,
      clients: CLIENTS[person] ?? [person],
      rank: index + 1,
      isSelf: person === selfPerson,
      tokens,
      outputTokens,
      totalTokens: tokens * 14,
      requests: Math.round(tokens / 40_000)
    }
  })
}

function okView(
  selfPerson: string,
  order: readonly string[],
  options: { staleMinutes?: number; rankChange?: TeamClaudeLeaderboardRankChange } = {}
): Extract<TeamClaudeLeaderboardView, { kind: 'ok' }> {
  const entries = board(selfPerson, order)
  const self = entries.find((entry) => entry.isSelf)
  const now = Date.now()
  const staleSince = options.staleMinutes === undefined ? null : now - options.staleMinutes * 60_000
  return {
    kind: 'ok',
    snapshot: {
      status: 'ok',
      window: '1d',
      fetchedAt: staleSince === null ? now - 2 * 60_000 : staleSince - 60_000,
      staleSince,
      entries,
      self: self ? { person: self.person, rank: self.rank, of: entries.length } : null
    },
    staleSince,
    rankChange: options.rankChange ?? null
  }
}

const DEFAULT_ORDER = ['brooke', 'chen', 'alex', 'dana', 'eli', 'ci-runner']
const ALEX_LEADS = ['alex', 'brooke', 'chen', 'dana', 'eli', 'ci-runner']
const ALEX_SECOND = ['brooke', 'alex', 'chen', 'dana', 'eli', 'ci-runner']

function SidebarFrame({
  view,
  initiallyExpanded = false
}: {
  view: Exclude<TeamClaudeLeaderboardView, { kind: 'hidden' }>
  initiallyExpanded?: boolean
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(initiallyExpanded)
  return (
    <div className="bg-worktree-sidebar pt-2 text-worktree-sidebar-foreground">
      <TeamClaudeLeaderboardPanel view={view} expanded={expanded} onExpandedChange={setExpanded} />
    </div>
  )
}

export const leader = defineFixture({
  width: SIDEBAR_WIDTH,
  render: () => <SidebarFrame view={okView('alex', ALEX_LEADS)} />
})

export const leaderExpanded = defineFixture({
  width: SIDEBAR_WIDTH,
  render: () => <SidebarFrame view={okView('alex', ALEX_LEADS)} initiallyExpanded />
})

export const midPack = defineFixture({
  width: SIDEBAR_WIDTH,
  render: () => <SidebarFrame view={okView('alex', DEFAULT_ORDER)} initiallyExpanded />
})

export const midPackMinWidth = defineFixture({
  width: SIDEBAR_MIN_WIDTH,
  render: () => <SidebarFrame view={okView('alex', DEFAULT_ORDER)} initiallyExpanded />
})

export const midPackRowTooltip = defineFixture({
  width: SIDEBAR_WIDTH,
  render: () => <SidebarFrame view={okView('alex', DEFAULT_ORDER)} initiallyExpanded />,
  interact: async (frame) => {
    frame.querySelector<HTMLElement>('[role="row"][data-current="true"]')?.focus()
    await SETTLE_ANIMATION()
  }
})

export const rankUp = defineFixture({
  width: SIDEBAR_WIDTH,
  render: () => (
    <SidebarFrame
      view={okView('alex', ALEX_SECOND, { rankChange: { direction: 'up', from: 3, to: 2 } })}
    />
  ),
  interact: SETTLE_ANIMATION
})

export const rankDown = defineFixture({
  width: SIDEBAR_MIN_WIDTH,
  render: () => (
    <SidebarFrame
      view={okView('alex', DEFAULT_ORDER, { rankChange: { direction: 'down', from: 2, to: 3 } })}
    />
  ),
  interact: SETTLE_ANIMATION
})

export const stale = defineFixture({
  width: SIDEBAR_WIDTH,
  render: () => (
    <SidebarFrame view={okView('alex', DEFAULT_ORDER, { staleMinutes: 9 })} initiallyExpanded />
  )
})

export const notRanked = defineFixture({
  width: SIDEBAR_WIDTH,
  render: () => <SidebarFrame view={okView('fern', DEFAULT_ORDER)} />
})

export const unavailable = defineFixture({
  width: SIDEBAR_WIDTH,
  render: () => (
    <SidebarFrame
      view={{
        kind: 'unavailable',
        message: 'TeamClaude coordinator did not answer: connect ECONNREFUSED 10.0.0.4:8787'
      }}
    />
  ),
  interact: async (frame) => {
    frame.querySelector<HTMLElement>('[data-teamclaude-leaderboard="unavailable"]')?.focus()
    await SETTLE_ANIMATION()
  }
})
