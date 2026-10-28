import { runProcess } from '@orca/process-host'
import { TeamClaudeLeaderboardError } from './teamclaude-leaderboard-error'

const STATUS_MAX_BYTES = 1024 * 1024
const CLIENT_NAME = /^[\x21-\x7e]{1,256}$/

// The coordinator names this host only through the wrapper's own route, and the name changes only on reinstall.
let resolved: { configPath: string; client: string } | null = null

/** This host's TeamClaude client name, as `teamclaude wrappers status` reports it for `configPath`. */
export async function resolveTeamClaudeSelfClient(
  configPath: string,
  signal: AbortSignal
): Promise<string> {
  if (resolved?.configPath === configPath) {
    return resolved.client
  }
  const unknown = new TeamClaudeLeaderboardError("Could not identify this host's TeamClaude client")
  let stdout: string
  try {
    const result = await runProcess({
      program: 'teamclaude',
      args: ['wrappers', 'status', '--json', '--config', configPath],
      signal,
      maxOutputBytes: STATUS_MAX_BYTES,
      killOnOutputLimit: true
    })
    stdout = result.outputTruncated ? '' : result.stdout
  } catch {
    throw unknown
  }
  signal.throwIfAborted()
  let status: unknown
  try {
    status = JSON.parse(stdout)
  } catch {
    throw unknown
  }
  const client =
    typeof status === 'object' && status !== null && 'client' in status ? status.client : null
  if (typeof client !== 'string' || !CLIENT_NAME.test(client)) {
    throw unknown
  }
  resolved = { configPath, client }
  return client
}
