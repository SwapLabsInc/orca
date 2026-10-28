import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProcessResult } from '@orca/process-host/process-spec'

const { runProcessMock } = vi.hoisted(() => ({ runProcessMock: vi.fn() }))

vi.mock('@orca/process-host', () => ({ runProcess: runProcessMock }))

import { resolveTeamClaudeCoordinator } from './teamclaude-coordinator-status'

const SERVER = 'devservices1.tailfa7aa.ts.net:3456'

function peer(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ID: 'nPeer1',
    DNSName: 'devservices1.tailfa7aa.ts.net.',
    Online: true,
    TailscaleIPs: ['100.101.102.103', 'fd7a:115c:a1e0::1'],
    ...overrides
  }
}

function netmap(peers: Record<string, unknown>[], backendState = 'Running'): ProcessResult {
  const Peer = Object.fromEntries(peers.map((value, index) => [`key${index}`, value]))
  return {
    code: 0,
    signal: null,
    stdout: JSON.stringify({ BackendState: backendState, Peer }),
    stderr: '',
    timedOut: false
  }
}

function resolve(server: string): ReturnType<typeof resolveTeamClaudeCoordinator> {
  return resolveTeamClaudeCoordinator(server, new AbortController().signal)
}

describe('resolveTeamClaudeCoordinator', () => {
  beforeEach(() => {
    runProcessMock.mockReset()
  })

  it.each([
    [SERVER, 3456],
    ['http://DevServices1.tailfa7aa.ts.net.:8080/', 8080],
    ['devservices1.tailfa7aa.ts.net', 3456]
  ])('pins %s to the netmap peer tailnet address', async (server, port) => {
    runProcessMock.mockResolvedValue(netmap([peer({ DNSName: 'other.tailfa7aa.ts.net.' }), peer()]))

    await expect(resolve(server)).resolves.toEqual({ ip: '100.101.102.103', port })
    expect(runProcessMock).toHaveBeenCalledWith(
      expect.objectContaining({ program: 'tailscale', args: ['status', '--json'] })
    )
  })

  it.each([
    'https://devservices1.tailfa7aa.ts.net',
    'http://operator:secret@devservices1.tailfa7aa.ts.net',
    'devservices1.tailfa7aa.ts.net/teamclaude',
    'devservices1.tailfa7aa.ts.net?x=1',
    'devservices1.example.com:3456',
    '100.101.102.103:3456',
    'devservices1.tailfa7aa.ts.net:0',
    ''
  ])('refuses %j before consulting Tailscale', async (server) => {
    await expect(resolve(server)).rejects.toThrow(
      'TeamClaude server is not a Tailscale coordinator name'
    )
    expect(runProcessMock).not.toHaveBeenCalled()
  })

  it.each([
    ['Tailscale is stopped', netmap([peer()], 'Stopped'), 'Tailscale is not running on this host'],
    [
      'two peers claim the name',
      netmap([peer(), peer({ ID: 'nPeer2' })]),
      'TeamClaude coordinator is not an online tailnet peer'
    ],
    [
      'the peer is offline',
      netmap([peer({ Online: false })]),
      'TeamClaude coordinator is not an online tailnet peer'
    ],
    [
      'the peer has no node ID',
      netmap([peer({ ID: '' })]),
      'TeamClaude coordinator is not an online tailnet peer'
    ],
    [
      'the peer has only public or malformed addresses',
      netmap([peer({ TailscaleIPs: ['8.8.8.8', 'not-an-ip', 42] })]),
      'TeamClaude coordinator has no tailnet address'
    ],
    ['the CLI fails', { ...netmap([peer()]), code: 1 }, 'Tailscale status failed on this host'],
    [
      'the CLI prints malformed JSON',
      { ...netmap([peer()]), stdout: '{"BackendState":' },
      'Tailscale status failed on this host'
    ]
  ])('refuses the coordinator when %s', async (_label, result, message) => {
    runProcessMock.mockResolvedValue(result)

    await expect(resolve(SERVER)).rejects.toThrow(message)
  })

  it('accepts an IPv6-only tailnet peer', async () => {
    runProcessMock.mockResolvedValue(netmap([peer({ TailscaleIPs: ['fd7a:115c:a1e0::9'] })]))

    await expect(resolve(SERVER)).resolves.toEqual({ ip: 'fd7a:115c:a1e0::9', port: 3456 })
  })
})
