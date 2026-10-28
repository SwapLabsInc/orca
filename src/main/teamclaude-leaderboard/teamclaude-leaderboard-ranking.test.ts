import { describe, expect, it } from 'vitest'
import { rankTeamClaudeLeaderboard, readTeamClaudeDayUsage } from './teamclaude-leaderboard-ranking'

function day(input: number, output: number, cacheCreation: number, cacheRead = 0): unknown {
  return { windows: { '1h': {}, '1d': { requests: 3, input, output, cacheRead, cacheCreation } } }
}

const STATUS = {
  caller: { kind: 'operator', client: null },
  usageWindows: {
    clients: {
      'minidev-alex1': day(10, 20, 30, 9_000),
      'MiniDev-Alex2': day(5, 15, 20, 1_000),
      'minidev-dan1': day(50, 25, 25),
      tankdinosaur: day(10, 20, 20),
      'sixthman-exec1': day(500, 500, 500),
      'remote-01b63a49': day(0, 0, 0),
      'minidev-rob1': day(0, 0, 0, 40_000)
    }
  }
}

describe('rankTeamClaudeLeaderboard', () => {
  it('folds minidevs into a person, drops automation and idle clients, and shares tied ranks', () => {
    const board = rankTeamClaudeLeaderboard(readTeamClaudeDayUsage(STATUS), 'minidev-alex2')

    expect(
      board.entries.map(({ person, clients, rank, tokens, totalTokens, isSelf }) => ({
        person,
        clients,
        rank,
        tokens,
        totalTokens,
        isSelf
      }))
    ).toEqual([
      {
        person: 'alex',
        clients: ['MiniDev-Alex2', 'minidev-alex1'],
        rank: 1,
        tokens: 100,
        totalTokens: 10_100,
        isSelf: true
      },
      {
        person: 'dan',
        clients: ['minidev-dan1'],
        rank: 1,
        tokens: 100,
        totalTokens: 100,
        isSelf: false
      },
      {
        person: 'tankdinosaur',
        clients: ['tankdinosaur'],
        rank: 3,
        tokens: 50,
        totalTokens: 50,
        isSelf: false
      }
    ])
    expect(board.entries[0]).toMatchObject({ outputTokens: 35, requests: 6 })
    expect(board.self).toEqual({ person: 'alex', rank: 1, of: 3 })
  })

  it.each(['minidev-rob1', 'sixthman-exec1', 'minidev-zed1'])(
    'reports no self for %s, which has no usage on the board',
    (selfClient) => {
      const board = rankTeamClaudeLeaderboard(readTeamClaudeDayUsage(STATUS), selfClient)

      expect(board.self).toBeNull()
      expect(board.entries.some((entry) => entry.isSelf)).toBe(false)
    }
  )
})

describe('readTeamClaudeDayUsage', () => {
  const counters = { requests: 1, input: 1, output: 1, cacheRead: 1, cacheCreation: 1 }
  const withDay = (window: unknown): unknown => ({
    usageWindows: { clients: { 'minidev-alex1': { windows: { '1d': window } } } }
  })

  it.each([
    ['no usage windows', { caller: {} }],
    ['clients as an array', { usageWindows: { clients: [] } }],
    ['a client without a day window', { usageWindows: { clients: { a: { windows: {} } } } }],
    ['a missing counter', withDay({ ...counters, cacheCreation: undefined })],
    ['a string counter', withDay({ ...counters, output: '12' })],
    ['a negative counter', withDay({ ...counters, input: -1 })],
    [
      'an overflowing counter',
      JSON.parse(
        '{"usageWindows":{"clients":{"a":{"windows":{"1d":{"requests":1,"input":1e999,"output":1,"cacheRead":1,"cacheCreation":1}}}}}}'
      )
    ]
  ])('rejects a payload with %s instead of reading zeros', (_label, payload) => {
    expect(() => readTeamClaudeDayUsage(payload)).toThrow('TeamClaude status payload is malformed')
  })

  it('keeps a real zero distinct from a malformed payload', () => {
    const usage = readTeamClaudeDayUsage(withDay({ ...counters, input: 0, output: 0 }))

    expect(usage).toEqual([{ client: 'minidev-alex1', ...counters, input: 0, output: 0 }])
  })
})
