import type {
  TeamClaudeLeaderboardEntry,
  TeamClaudeLeaderboardSnapshot
} from '../../shared/teamclaude-leaderboard-types'
import { TeamClaudeLeaderboardError } from './teamclaude-leaderboard-error'

/** One client's `usageWindows.clients[name].windows['1d']` counters from the status payload. */
export type TeamClaudeClientDayUsage = {
  client: string
  requests: number
  input: number
  output: number
  cacheRead: number
  cacheCreation: number
}

export type TeamClaudeRankedBoard = Pick<
  Extract<TeamClaudeLeaderboardSnapshot, { status: 'ok' }>,
  'entries' | 'self'
>

const MINIDEV_CLIENT = /^minidev-([a-z]+?)\d+$/i
const AUTOMATION_CLIENT = /^sixthman-/i

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function malformed(): TeamClaudeLeaderboardError {
  return new TeamClaudeLeaderboardError('TeamClaude status payload is malformed')
}

function counter(window: Record<string, unknown>, key: string): number {
  const value = window[key]
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw malformed()
  }
  return value
}

/** Rejects the whole payload on any malformed client: a skipped client would silently undercount a person. */
export function readTeamClaudeDayUsage(payload: unknown): TeamClaudeClientDayUsage[] {
  const usageWindows = isRecord(payload) ? payload.usageWindows : undefined
  const clients = isRecord(usageWindows) ? usageWindows.clients : undefined
  if (!isRecord(clients)) {
    throw malformed()
  }
  return Object.entries(clients).map(([client, entry]) => {
    const windows = isRecord(entry) ? entry.windows : undefined
    const day = isRecord(windows) ? windows['1d'] : undefined
    if (!client || !isRecord(day)) {
      throw malformed()
    }
    return {
      client,
      requests: counter(day, 'requests'),
      input: counter(day, 'input'),
      output: counter(day, 'output'),
      cacheRead: counter(day, 'cacheRead'),
      cacheCreation: counter(day, 'cacheCreation')
    }
  })
}

/** `minidev-<person><n>` clients fold into one person; other client names stand alone. */
export function teamClaudePersonOf(client: string): string {
  return MINIDEV_CLIENT.exec(client)?.[1]?.toLowerCase() ?? client
}

export function rankTeamClaudeLeaderboard(
  usage: readonly TeamClaudeClientDayUsage[],
  selfClient: string
): TeamClaudeRankedBoard {
  const persons = new Map<string, Omit<TeamClaudeLeaderboardEntry, 'rank' | 'isSelf'>>()
  for (const row of usage) {
    if (AUTOMATION_CLIENT.test(row.client)) {
      continue
    }
    const person = teamClaudePersonOf(row.client)
    const totals = persons.get(person) ?? {
      person,
      clients: [],
      tokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      requests: 0
    }
    const fresh = row.input + row.output + row.cacheCreation
    if (fresh > 0) {
      totals.clients.push(row.client)
    }
    totals.tokens += fresh
    totals.outputTokens += row.output
    totals.totalTokens += fresh + row.cacheRead
    totals.requests += row.requests
    persons.set(person, totals)
  }
  const selfPerson = AUTOMATION_CLIENT.test(selfClient) ? null : teamClaudePersonOf(selfClient)
  const totals = [...persons.values()]
  if (totals.some((sum) => !Number.isFinite(sum.totalTokens) || !Number.isFinite(sum.requests))) {
    throw malformed()
  }
  const ranked = totals
    .filter((sum) => sum.tokens > 0)
    .sort((a, b) => b.tokens - a.tokens || (a.person < b.person ? -1 : 1))
  const entries: TeamClaudeLeaderboardEntry[] = []
  for (const [index, sum] of ranked.entries()) {
    const previous = entries.at(-1)
    entries.push({
      ...sum,
      clients: sum.clients.sort(),
      rank: previous?.tokens === sum.tokens ? previous.rank : index + 1,
      isSelf: sum.person === selfPerson
    })
  }
  const self = entries.find((entry) => entry.isSelf)
  return {
    entries,
    self: self ? { person: self.person, rank: self.rank, of: entries.length } : null
  }
}
