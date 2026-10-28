import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TeamClaudeLeaderboardError } from './teamclaude-leaderboard-error'
import {
  TeamClaudeLeaderboardService,
  type TeamClaudeLeaderboardRead
} from './teamclaude-leaderboard-service'

function board(fetchedAt: number, tokens: number): TeamClaudeLeaderboardRead {
  return {
    status: 'ok',
    fetchedAt,
    entries: [
      {
        person: 'alex',
        clients: ['minidev-alex1'],
        rank: 1,
        isSelf: true,
        tokens,
        outputTokens: 0,
        totalTokens: tokens,
        requests: 1
      }
    ],
    self: { person: 'alex', rank: 1, of: 1 }
  }
}

function createService(read: (signal: AbortSignal) => Promise<TeamClaudeLeaderboardRead>) {
  return new TeamClaudeLeaderboardService({ read, now: Date.now })
}

describe('TeamClaudeLeaderboardService', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('shares one read between concurrent callers and rereads only after the refresh interval', async () => {
    const read = vi.fn(async () => board(Date.now(), 7))
    const service = createService(read)

    const [first, second] = await Promise.all([service.get(), service.get()])
    vi.setSystemTime(59_999)
    const cached = await service.get()
    vi.setSystemTime(60_000)
    const refreshed = await service.get()

    expect(read).toHaveBeenCalledTimes(2)
    expect(second).toBe(first)
    expect(cached).toBe(first)
    expect(refreshed).toMatchObject({ status: 'ok', fetchedAt: 60_000, staleSince: null })
  })

  it('keeps serving the last good board, stale from the first failed refresh', async () => {
    const read = vi
      .fn<(signal: AbortSignal) => Promise<TeamClaudeLeaderboardRead>>()
      .mockResolvedValueOnce(board(0, 7))
      .mockRejectedValueOnce(
        new TeamClaudeLeaderboardError('TeamClaude coordinator is unreachable')
      )
      .mockRejectedValueOnce(
        new TeamClaudeLeaderboardError('TeamClaude coordinator answered HTTP 503')
      )
      .mockResolvedValueOnce(board(180_000, 9))
    const service = createService(read)

    await service.get()
    vi.setSystemTime(60_000)
    const firstFailure = await service.get()
    vi.setSystemTime(120_000)
    const secondFailure = await service.get()
    vi.setSystemTime(180_000)
    const recovered = await service.get()

    expect(firstFailure).toMatchObject({ status: 'ok', fetchedAt: 0, staleSince: 60_000 })
    expect(secondFailure).toMatchObject({ status: 'ok', fetchedAt: 0, staleSince: 60_000 })
    expect(recovered).toMatchObject({ status: 'ok', fetchedAt: 180_000, staleSince: null })
  })

  it('reports why the board is unavailable until a first read succeeds, without leaking raw errors', async () => {
    const read = vi
      .fn<(signal: AbortSignal) => Promise<TeamClaudeLeaderboardRead>>()
      .mockRejectedValueOnce(
        new TeamClaudeLeaderboardError('TeamClaude status payload is malformed')
      )
      .mockRejectedValueOnce(
        new Error('EACCES: permission denied, open /home/alex/.teamclaude/key')
      )
    const service = createService(read)
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    const malformed = await service.get()
    vi.setSystemTime(60_000)
    const unexpected = await service.get()

    expect(malformed).toEqual({
      status: 'unavailable',
      message: 'TeamClaude status payload is malformed'
    })
    expect(unexpected).toEqual({
      status: 'unavailable',
      message: 'TeamClaude leaderboard read failed'
    })
  })

  it('drops a read that outlives its deadline even when it completes after a newer read', async () => {
    let abandoned: { signal: AbortSignal; resolve: (read: TeamClaudeLeaderboardRead) => void }
    const read = vi
      .fn<(signal: AbortSignal) => Promise<TeamClaudeLeaderboardRead>>()
      .mockImplementationOnce(
        (signal) => new Promise((resolve) => (abandoned = { signal, resolve }))
      )
      .mockImplementationOnce(async () => board(60_000, 9))
    const service = createService(read)

    const timedOut = service.get()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(await timedOut).toEqual({
      status: 'unavailable',
      message: 'TeamClaude read timed out after 10 seconds'
    })
    expect(abandoned!.signal.aborted).toBe(true)

    vi.setSystemTime(60_000)
    const newer = await service.get()
    abandoned!.resolve(board(5_000, 1))
    await vi.advanceTimersByTimeAsync(0)

    expect(newer).toMatchObject({ status: 'ok', fetchedAt: 60_000 })
    expect(await service.get()).toBe(newer)
  })

  it('serves not-configured without keeping a board from before the uninstall', async () => {
    const read = vi
      .fn<(signal: AbortSignal) => Promise<TeamClaudeLeaderboardRead>>()
      .mockResolvedValueOnce(board(0, 7))
      .mockResolvedValueOnce({ status: 'not-configured' })
      .mockRejectedValueOnce(new TeamClaudeLeaderboardError('TeamClaude wrapper config is invalid'))
    const service = createService(read)

    await service.get()
    vi.setSystemTime(60_000)
    const uninstalled = await service.get()
    vi.setSystemTime(120_000)
    const broken = await service.get()

    expect(uninstalled).toEqual({ status: 'not-configured' })
    expect(broken).toEqual({
      status: 'unavailable',
      message: 'TeamClaude wrapper config is invalid'
    })
  })
})
