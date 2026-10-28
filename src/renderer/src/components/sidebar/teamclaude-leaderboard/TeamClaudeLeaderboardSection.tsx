import React from 'react'
import { useActiveAccountOwner } from '@/runtime/use-worktree-runtime-target'
import type { RuntimeClientTarget } from '../../../../../shared/runtime-client-target'
import { TeamClaudeLeaderboardPanel } from './TeamClaudeLeaderboardPanel'
import { useTeamClaudeLeaderboard } from './use-teamclaude-leaderboard'

const LOCAL_TARGET: RuntimeClientTarget = { kind: 'local' }
const EXPANDED_STORAGE_KEY = 'orca.teamclaudeLeaderboardExpanded.v1'

function readExpanded(): boolean {
  try {
    return window.localStorage.getItem(EXPANDED_STORAGE_KEY) === 'true'
  } catch {
    return false
  }
}

function writeExpanded(expanded: boolean): void {
  try {
    window.localStorage.setItem(EXPANDED_STORAGE_KEY, String(expanded))
  } catch {
    // Expansion is a convenience; it resets to collapsed next launch.
  }
}

/** Fleet-wide TeamClaude standings above the sidebar toolbar; absent where the runtime does not serve them. */
export const TeamClaudeLeaderboardSection = React.memo(
  function TeamClaudeLeaderboardSection(): React.JSX.Element | null {
    // Why: same owner the status bar reads Claude usage from; any host serves the whole fleet.
    const { target } = useActiveAccountOwner(LOCAL_TARGET)
    const view = useTeamClaudeLeaderboard(target)
    const [expanded, setExpanded] = React.useState(readExpanded)
    const handleExpandedChange = React.useCallback((next: boolean) => {
      setExpanded(next)
      writeExpanded(next)
    }, [])

    if (view.kind === 'hidden') {
      return null
    }
    return (
      <TeamClaudeLeaderboardPanel
        view={view}
        expanded={expanded}
        onExpandedChange={handleExpandedChange}
      />
    )
  }
)
