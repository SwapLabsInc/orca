import { request } from 'node:http'
import { BlockList, isIP } from 'node:net'
import { runProcess } from '@orca/process-host'
import { TeamClaudeLeaderboardError } from './teamclaude-leaderboard-error'

export type TeamClaudeCoordinatorAddress = {
  ip: string
  port: number
}

const DEFAULT_PORT = 3456
const STATUS_PATH = '/teamclaude/status'
// The payload carries every account's usage windows and grows with the fleet (~4 MB in October 2026).
const STATUS_MAX_BYTES = 32 * 1024 * 1024
const NETMAP_MAX_BYTES = 16 * 1024 * 1024
const SERVER_PATTERN = /^(?:http:\/\/)?([a-z0-9.-]+?)\.?(?::(\d{1,5}))?\/?$/i

const TAILNET_RANGES = new BlockList()
TAILNET_RANGES.addSubnet('100.64.0.0', 10, 'ipv4')
TAILNET_RANGES.addSubnet('fd7a:115c:a1e0::', 48, 'ipv6')

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Only an `http` Tailscale MagicDNS name, without credentials, path, query or fragment. */
function parseTeamClaudeServer(server: string): { hostname: string; port: number } {
  const match = SERVER_PATTERN.exec(server.trim())
  const hostname = match?.[1]?.toLowerCase()
  const port = match?.[2] === undefined ? DEFAULT_PORT : Number(match[2])
  if (!hostname || !/^[^.].*\.ts\.net$/.test(hostname) || port < 1 || port > 65_535) {
    throw new TeamClaudeLeaderboardError('TeamClaude server is not a Tailscale coordinator name')
  }
  return { hostname, port }
}

/** The tailnet address of the single online peer the authenticated netmap binds to `hostname`. */
function findTeamClaudePeerAddress(netmap: unknown, hostname: string): string {
  if (!isRecord(netmap) || netmap.BackendState !== 'Running') {
    throw new TeamClaudeLeaderboardError('Tailscale is not running on this host')
  }
  const peers = isRecord(netmap.Peer) ? Object.values(netmap.Peer) : []
  const matches = peers.filter(
    (peer): peer is Record<string, unknown> =>
      isRecord(peer) &&
      typeof peer.DNSName === 'string' &&
      peer.DNSName.replace(/\.$/, '').toLowerCase() === hostname
  )
  const peer = matches.length === 1 ? matches[0] : undefined
  if (!peer || typeof peer.ID !== 'string' || !peer.ID || peer.Online !== true) {
    throw new TeamClaudeLeaderboardError('TeamClaude coordinator is not an online tailnet peer')
  }
  const ips = Array.isArray(peer.TailscaleIPs) ? peer.TailscaleIPs : []
  for (const ip of ips) {
    const family = typeof ip === 'string' ? isIP(ip) : 0
    if (family !== 0 && TAILNET_RANGES.check(ip, family === 4 ? 'ipv4' : 'ipv6')) {
      return ip
    }
  }
  throw new TeamClaudeLeaderboardError('TeamClaude coordinator has no tailnet address')
}

// Trust the daemon's authenticated netmap, never DNS or the address range alone, before sending the operator key.
export async function resolveTeamClaudeCoordinator(
  server: string,
  signal: AbortSignal
): Promise<TeamClaudeCoordinatorAddress> {
  const { hostname, port } = parseTeamClaudeServer(server)
  let result: Awaited<ReturnType<typeof runProcess>>
  try {
    result = await runProcess({
      program: 'tailscale',
      args: ['status', '--json'],
      signal,
      maxOutputBytes: NETMAP_MAX_BYTES,
      killOnOutputLimit: true
    })
  } catch {
    throw new TeamClaudeLeaderboardError('Tailscale CLI is unavailable on this host')
  }
  signal.throwIfAborted()
  if (result.code !== 0 || result.outputTruncated) {
    throw new TeamClaudeLeaderboardError('Tailscale status failed on this host')
  }
  let netmap: unknown
  try {
    netmap = JSON.parse(result.stdout)
  } catch {
    throw new TeamClaudeLeaderboardError('Tailscale status failed on this host')
  }
  return { ip: findTeamClaudePeerAddress(netmap, hostname), port }
}

/** GET the status route on the pinned peer: no DNS lookup, proxy agent or redirect following. */
export function requestTeamClaudeStatus(
  address: TeamClaudeCoordinatorAddress,
  key: string,
  signal: AbortSignal
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const fail = (message: string): void => {
      req.destroy()
      reject(signal.aborted ? signal.reason : new TeamClaudeLeaderboardError(message))
    }
    const req = request(
      {
        host: address.ip,
        port: address.port,
        method: 'GET',
        path: STATUS_PATH,
        headers: { 'x-api-key': key, accept: 'application/json' },
        agent: false,
        signal
      },
      (response) => {
        if (response.statusCode !== 200) {
          response.resume()
          fail(`TeamClaude coordinator answered HTTP ${response.statusCode ?? 'unknown'}`)
          return
        }
        const chunks: Buffer[] = []
        let size = 0
        response.on('data', (chunk: Buffer) => {
          size += chunk.length
          if (size > STATUS_MAX_BYTES) {
            fail('TeamClaude status response is too large')
            return
          }
          chunks.push(chunk)
        })
        response.on('error', () => fail('TeamClaude coordinator closed the connection'))
        response.on('end', () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks, size).toString('utf8')))
          } catch {
            reject(new TeamClaudeLeaderboardError('TeamClaude status payload is malformed'))
          }
        })
      }
    )
    req.on('error', () => fail('TeamClaude coordinator is unreachable'))
    req.end()
  })
}
