// @vitest-environment happy-dom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeClientTarget } from '../../../../../shared/runtime-client-target'
import type { TeamClaudeLeaderboardSnapshot } from '../../../../../shared/teamclaude-leaderboard-types'
import { getTeamClaudeLeaderboard } from '@/runtime/runtime-teamclaude-leaderboard-client'
import {
  useTeamClaudeLeaderboard,
  type TeamClaudeLeaderboardView
} from './use-teamclaude-leaderboard'

vi.mock('@/runtime/runtime-teamclaude-leaderboard-client', () => ({
  getTeamClaudeLeaderboard: vi.fn()
}))

type Read = {
  target: RuntimeClientTarget
  resolve: (snapshot: TeamClaudeLeaderboardSnapshot | null) => void
  reject: (error: Error) => void
}

const LOCAL: RuntimeClientTarget = { kind: 'local' }
const SERVER: RuntimeClientTarget = { kind: 'environment', environmentId: 'env-server' }

let reads: Read[] = []
let latestView: TeamClaudeLeaderboardView | null = null
let root: Root | null = null

function Probe({ target }: { target: RuntimeClientTarget }): null {
  latestView = useTeamClaudeLeaderboard(target)
  return null
}

function render(target: RuntimeClientTarget): void {
  if (!root) {
    const container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  }
  const mounted = root
  act(() => mounted.render(createElement(Probe, { target })))
}

function board(person: string, rank: number, fetchedAt: number): TeamClaudeLeaderboardSnapshot {
  return {
    status: 'ok',
    window: '1d',
    fetchedAt,
    staleSince: null,
    entries: [
      {
        person,
        clients: [`minidev-${person}1`],
        rank,
        isSelf: true,
        tokens: 1_000_000,
        outputTokens: 100_000,
        totalTokens: 9_000_000,
        requests: 12
      }
    ],
    self: { person, rank, of: 6 }
  }
}

async function settle(read: Read, outcome: TeamClaudeLeaderboardSnapshot | Error): Promise<void> {
  await act(async () => {
    if (outcome instanceof Error) {
      read.reject(outcome)
    } else {
      read.resolve(outcome)
    }
  })
}

describe('useTeamClaudeLeaderboard', () => {
  beforeEach(() => {
    reads = []
    latestView = null
    vi.mocked(getTeamClaudeLeaderboard).mockImplementation(
      (target) =>
        new Promise((resolve, reject) => {
          reads.push({ target, resolve, reject })
        })
    )
  })

  afterEach(() => {
    const mounted = root
    root = null
    if (mounted) {
      act(() => mounted.unmount())
    }
    vi.mocked(getTeamClaudeLeaderboard).mockReset()
  })

  it('keeps the newer read when an older one resolves after it', async () => {
    render(LOCAL)
    render(SERVER)
    expect(reads.map((read) => read.target)).toEqual([LOCAL, SERVER])

    await settle(reads[1], board('alex', 2, 2_000))
    await settle(reads[0], board('alex', 5, 1_000))

    expect(latestView).toMatchObject({ kind: 'ok', snapshot: { fetchedAt: 2_000 } })
  })

  it('marks the last board stale when the runtime stops answering, never zeroing it', async () => {
    render(LOCAL)
    await settle(reads[0], board('alex', 2, 1_000))

    act(() => window.dispatchEvent(new Event('focus')))
    await settle(reads[1], new Error('runtime unreachable'))

    expect(latestView).toMatchObject({
      kind: 'ok',
      snapshot: { fetchedAt: 1_000, self: { rank: 2 } },
      staleSince: expect.any(Number)
    })
  })
})
