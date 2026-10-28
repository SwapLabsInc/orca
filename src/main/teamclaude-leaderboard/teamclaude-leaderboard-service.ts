import { homedir } from 'node:os'
import {
  TEAMCLAUDE_LEADERBOARD_REFRESH_MS,
  type TeamClaudeLeaderboardSnapshot
} from '../../shared/teamclaude-leaderboard-types'
import {
  requestTeamClaudeStatus,
  resolveTeamClaudeCoordinator
} from './teamclaude-coordinator-status'
import { TeamClaudeLeaderboardError } from './teamclaude-leaderboard-error'
import {
  rankTeamClaudeLeaderboard,
  readTeamClaudeDayUsage,
  type TeamClaudeClientDayUsage,
  type TeamClaudeRankedBoard
} from './teamclaude-leaderboard-ranking'
import { resolveTeamClaudeSelfClient } from './teamclaude-self-client'
import {
  readTeamClaudeKey,
  readTeamClaudeWrapperConfig,
  teamClaudeWrapperConfigPath
} from './teamclaude-wrapper-config'

type TeamClaudeBoardSnapshot = Extract<TeamClaudeLeaderboardSnapshot, { status: 'ok' }>

export type TeamClaudeLeaderboardRead =
  | { status: 'not-configured' }
  | ({ status: 'ok'; fetchedAt: number } & TeamClaudeRankedBoard)

/** One deadline covers the tailscale lookup, the status request and the self lookup. */
const TEAMCLAUDE_READ_DEADLINE_MS = 10_000

/** Reads the coordinator once; the raw payload and the key never leave this function. */
async function readTeamClaudeLeaderboard(signal: AbortSignal): Promise<TeamClaudeLeaderboardRead> {
  if (process.platform === 'win32') {
    return { status: 'not-configured' }
  }
  const configPath = teamClaudeWrapperConfigPath(process.env, homedir())
  const config = await readTeamClaudeWrapperConfig(configPath)
  if (!config) {
    return { status: 'not-configured' }
  }
  const readUsage = async (): Promise<{
    fetchedAt: number
    usage: TeamClaudeClientDayUsage[]
  }> => {
    const key = await readTeamClaudeKey(config.keyFile)
    const address = await resolveTeamClaudeCoordinator(config.server, signal)
    const payload = await requestTeamClaudeStatus(address, key, signal)
    return { fetchedAt: Date.now(), usage: readTeamClaudeDayUsage(payload) }
  }
  const [{ fetchedAt, usage }, selfClient] = await Promise.all([
    readUsage(),
    resolveTeamClaudeSelfClient(configPath, signal)
  ])
  return { status: 'ok', fetchedAt, ...rankTeamClaudeLeaderboard(usage, selfClient) }
}

/**
 * Rereads only when asked and at most once per refresh interval; concurrent callers share one read.
 * A failed refresh keeps the last good board, marked stale from the first failure.
 */
export class TeamClaudeLeaderboardService {
  private snapshot: TeamClaudeLeaderboardSnapshot | null = null
  private board: TeamClaudeBoardSnapshot | null = null
  private failedSince: number | null = null
  private attemptedAt: number | null = null
  private inFlight: Promise<TeamClaudeLeaderboardSnapshot> | null = null

  constructor(
    private readonly deps: {
      read: (signal: AbortSignal) => Promise<TeamClaudeLeaderboardRead>
      now: () => number
    }
  ) {}

  get(): Promise<TeamClaudeLeaderboardSnapshot> {
    if (this.inFlight) {
      return this.inFlight
    }
    const now = this.deps.now()
    const age = this.attemptedAt === null ? null : now - this.attemptedAt
    if (this.snapshot && age !== null && age >= 0 && age < TEAMCLAUDE_LEADERBOARD_REFRESH_MS) {
      return Promise.resolve(this.snapshot)
    }
    this.attemptedAt = now
    const inFlight = this.refresh().finally(() => {
      if (this.inFlight === inFlight) {
        this.inFlight = null
      }
    })
    this.inFlight = inFlight
    return inFlight
  }

  // The deadline settles this refresh even if the read ignores abort, so a late result is dropped, never published.
  private async refresh(): Promise<TeamClaudeLeaderboardSnapshot> {
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        const error = new TeamClaudeLeaderboardError('TeamClaude read timed out after 10 seconds')
        controller.abort(error)
        reject(error)
      }, TEAMCLAUDE_READ_DEADLINE_MS)
    })
    try {
      return this.publishRead(await Promise.race([this.deps.read(controller.signal), deadline]))
    } catch (error) {
      return this.publishFailure(error)
    } finally {
      clearTimeout(timer)
      // Releases a sibling lookup still running after the other one failed.
      controller.abort()
    }
  }

  private publishRead(read: TeamClaudeLeaderboardRead): TeamClaudeLeaderboardSnapshot {
    this.failedSince = null
    this.board =
      read.status === 'ok'
        ? {
            status: 'ok',
            window: '1d',
            fetchedAt: read.fetchedAt,
            staleSince: null,
            entries: read.entries,
            self: read.self
          }
        : null
    this.snapshot = this.board ?? { status: 'not-configured' }
    return this.snapshot
  }

  private publishFailure(error: unknown): TeamClaudeLeaderboardSnapshot {
    if (!(error instanceof TeamClaudeLeaderboardError)) {
      console.warn(
        '[teamclaude-leaderboard] read failed unexpectedly:',
        error instanceof Error ? error.message : String(error)
      )
    }
    this.failedSince ??= this.deps.now()
    this.snapshot = this.board
      ? { ...this.board, staleSince: this.failedSince }
      : {
          status: 'unavailable',
          message:
            error instanceof TeamClaudeLeaderboardError
              ? error.message
              : 'TeamClaude leaderboard read failed'
        }
    return this.snapshot
  }
}

let service: TeamClaudeLeaderboardService | null = null

export function getTeamClaudeLeaderboard(): Promise<TeamClaudeLeaderboardSnapshot> {
  service ??= new TeamClaudeLeaderboardService({
    read: readTeamClaudeLeaderboard,
    now: Date.now
  })
  return service.get()
}
