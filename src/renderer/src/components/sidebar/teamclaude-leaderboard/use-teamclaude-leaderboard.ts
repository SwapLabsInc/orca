import { useEffect, useRef, useState } from 'react'
import { installWindowVisibilityTimeoutPoller } from '@/lib/window-visibility-timeout-poller'
import {
  runtimeTargetEnvironmentId,
  runtimeTargetForOwnerEnvironment
} from '@/runtime/runtime-client-target'
import { getTeamClaudeLeaderboard } from '@/runtime/runtime-teamclaude-leaderboard-client'
import type { RuntimeClientTarget } from '../../../../../shared/runtime-client-target'
import {
  TEAMCLAUDE_LEADERBOARD_REFRESH_MS,
  type TeamClaudeLeaderboardSnapshot
} from '../../../../../shared/teamclaude-leaderboard-types'
import {
  getTeamClaudeLeaderboardRankChange,
  type TeamClaudeLeaderboardOkSnapshot,
  type TeamClaudeLeaderboardRankChange
} from './teamclaude-leaderboard-standing'

const RANK_CHANGE_VISIBLE_MS = 8_000

export type TeamClaudeLeaderboardView =
  | { kind: 'hidden' }
  | { kind: 'unavailable'; message: string }
  | {
      kind: 'ok'
      snapshot: TeamClaudeLeaderboardOkSnapshot
      /** The host's failed coordinator refresh, or this renderer's failed read of the host. */
      staleSince: number | null
      rankChange: TeamClaudeLeaderboardRankChange | null
    }

const HIDDEN_VIEW: TeamClaudeLeaderboardView = { kind: 'hidden' }

function applySnapshot(
  previous: TeamClaudeLeaderboardView,
  snapshot: TeamClaudeLeaderboardSnapshot | null
): TeamClaudeLeaderboardView {
  if (!snapshot || snapshot.status === 'not-configured') {
    return HIDDEN_VIEW
  }
  if (snapshot.status === 'unavailable') {
    return { kind: 'unavailable', message: snapshot.message }
  }
  const previousSelf = previous.kind === 'ok' ? previous.snapshot.self : null
  const change = getTeamClaudeLeaderboardRankChange(previousSelf, snapshot.self)
  // Why: a focus refresh right after a move must not cut the indicator short.
  const carried =
    previous.kind === 'ok' &&
    previous.rankChange &&
    previousSelf?.person === snapshot.self?.person &&
    snapshot.self?.rank === previous.rankChange.to
      ? previous.rankChange
      : null
  return {
    kind: 'ok',
    snapshot,
    staleSince: snapshot.staleSince,
    rankChange: change ?? carried
  }
}

function applyReadFailure(
  previous: TeamClaudeLeaderboardView,
  failedAt: number
): TeamClaudeLeaderboardView {
  // Why: losing the runtime keeps its last coordinator read on screen, marked stale, never zeroed.
  return previous.kind === 'ok' && previous.staleSince === null
    ? { ...previous, staleSince: failedAt }
    : previous
}

/** Polls the fleet-wide board from `target` while the window is visible; hidden when the runtime does not serve it. */
export function useTeamClaudeLeaderboard(target: RuntimeClientTarget): TeamClaudeLeaderboardView {
  const [view, setView] = useState<TeamClaudeLeaderboardView>(HIDDEN_VIEW)
  const requestSeqRef = useRef(0)
  const environmentId = runtimeTargetEnvironmentId(target)

  // Why: the board is fleet-wide, so a switched target keeps the last board until it answers.
  useEffect(() => {
    const pollTarget = runtimeTargetForOwnerEnvironment(environmentId)
    const stopPolling = installWindowVisibilityTimeoutPoller({
      getDelayMs: () => TEAMCLAUDE_LEADERBOARD_REFRESH_MS,
      run: async () => {
        const seq = ++requestSeqRef.current
        try {
          const snapshot = await getTeamClaudeLeaderboard(pollTarget)
          if (seq === requestSeqRef.current) {
            setView((previous) => applySnapshot(previous, snapshot))
          }
        } catch {
          if (seq === requestSeqRef.current) {
            const failedAt = Date.now()
            setView((previous) => applyReadFailure(previous, failedAt))
          }
        }
      }
    })
    return () => {
      // Why: drops replies still in flight from a previous target or an unmounted section.
      requestSeqRef.current += 1
      stopPolling()
    }
  }, [environmentId])

  const rankChange = view.kind === 'ok' ? view.rankChange : null
  useEffect(() => {
    if (!rankChange) {
      return
    }
    const timer = setTimeout(() => {
      setView((previous) =>
        previous.kind === 'ok' && previous.rankChange === rankChange
          ? { ...previous, rankChange: null }
          : previous
      )
    }, RANK_CHANGE_VISIBLE_MS)
    return () => clearTimeout(timer)
  }, [rankChange])

  return view
}
