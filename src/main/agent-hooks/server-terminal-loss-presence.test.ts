import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RelayAgentHookServer } from '../../relay/agent-hook-server'
import type { AgentHookRelayUserEndedSessionEnvelope } from '../../shared/agent-hook-relay'
import { AgentHookServer, _internals } from './server'
import { buildBody, PANE, postHookEvent } from './server.test-fixtures'

vi.mock('../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../telemetry/cohort-classifier', () => ({ getCohortAtEmit: vi.fn(() => ({})) }))

const probe = vi.hoisted(() =>
  vi.fn(async (): Promise<'live' | 'unverifiable' | 'exited'> => 'unverifiable')
)
vi.mock('../../shared/agent-process-presence-probe', () => ({ probeAgentProcessPresence: probe }))

const SESSION = 'c0ffee00-0000-4000-8000-000000000001'
const TRANSCRIPT = '/home/u/.claude/projects/p/c0ffee00.jsonl'
const RESUME = {
  agent: 'claude',
  providerSession: { key: 'session_id', id: SESSION, transcriptPath: TRANSCRIPT }
}
const AGENT_PROCESS = JSON.stringify({ pid: 4001, platform: 'linux', startTime: 'birth-4001' })
const notLive = (): boolean => false

let dir: string
const servers: { stop: () => void }[] = []

beforeEach(() => {
  _internals.resetCachesForTests()
  dir = mkdtempSync(join(tmpdir(), 'orca-terminal-loss-presence-'))
})

afterEach(() => {
  for (const server of servers.splice(0)) {
    server.stop()
  }
  probe.mockReset()
  probe.mockResolvedValue('unverifiable')
  rmSync(dir, { recursive: true, force: true })
})

async function startServer(userDataPath = join(dir, 'host')): Promise<AgentHookServer> {
  const server = new AgentHookServer()
  servers.push(server)
  await server.start({ env: 'production', userDataPath })
  return server
}

/** A hook from the pane's Claude, carrying the process identity its hook script captures. */
async function hook(server: AgentHookServer, payload: Record<string, unknown>): Promise<void> {
  const body = buildBody(
    { session_id: SESSION, transcript_path: TRANSCRIPT, ...payload },
    { agentProcess: AGENT_PROCESS }
  )
  expect((await postHookEvent(server, body)).status).toBe(204)
}

async function runIdleTurn(server: AgentHookServer): Promise<void> {
  await hook(server, { hook_event_name: 'SessionStart', source: 'startup' })
  await hook(server, { hook_event_name: 'UserPromptSubmit', prompt: 'ship it' })
  await hook(server, { hook_event_name: 'Stop' })
}

function visible(server: AgentHookServer): boolean {
  return server.getStatusSnapshotForPane(PANE).some((row) => !row.providerSessionOnly)
}

describe('an identified Claude whose process reports its own exit', () => {
  it('keeps resuming a session a signal ended, before and after its terminal goes', async () => {
    const server = await startServer()
    await runIdleTurn(server)

    await hook(server, { hook_event_name: 'SessionEnd', reason: 'other' })

    expect(visible(server)).toBe(false)
    expect(server.hasVerifiableAgentProcess(PANE)).toBe(false)
    expect(server.selectTerminalLossResume(PANE, notLive)).toEqual(RESUME)
    server.clearPaneState(PANE)
    expect(server.selectTerminalLossResume(PANE, notLive)).toEqual(RESUME)
  })

  for (const reason of ['prompt_input_exit', 'logout', 'bypass_permissions_disabled']) {
    it(`keeps a session ended with ${reason} for a manual resume only`, async () => {
      const server = await startServer()
      await runIdleTurn(server)

      await hook(server, { hook_event_name: 'SessionEnd', reason })
      await hook(server, { hook_event_name: 'Stop' })

      expect(visible(server)).toBe(false)
      expect(server.hasVerifiableAgentProcess(PANE)).toBe(false)
      expect(server.getStatusSnapshotForPane(PANE)).toEqual([
        expect.objectContaining({ providerSessionOnly: true })
      ])
      expect(server.selectTerminalLossResume(PANE, notLive)).toBeNull()
      server.clearPaneState(PANE)
      expect(server.selectTerminalLossResume(PANE, notLive)).toBeNull()
    })
  }

  it('lets a shell that outlived a signal-ended Claude retire it to a manual resume', async () => {
    const server = await startServer()
    await runIdleTurn(server)
    await hook(server, { hook_event_name: 'SessionEnd', reason: 'other' })

    server.reconcileEndedProcessForPaneKeys([PANE], { preserveResumeIdentity: true })

    expect(server.selectTerminalLossResume(PANE, notLive)).toBeNull()
  })
})

describe('a process check on a pane whose terminal was lost', () => {
  it('keeps the pane resumable when a probe after a restart finds its agent gone', async () => {
    const userDataPath = join(dir, 'host')
    const first = await startServer(userDataPath)
    await runIdleTurn(first)
    first.flushStatusPersistSync()
    first.stop()
    const spoolDir = join(userDataPath, 'agent-hooks', 'spool')
    mkdirSync(spoolDir, { recursive: true })
    const record = JSON.stringify({
      paneKey: PANE,
      source: 'claude',
      receivedAt: Date.now(),
      agentProcess: AGENT_PROCESS,
      payload: { hook_event_name: 'Notification', session_id: SESSION, message: 'idle' }
    })
    writeFileSync(join(spoolDir, 'pane-spooled.jsonl'), `\n${record}\n`)
    probe.mockResolvedValue('exited')

    const restarted = await startServer(userDataPath)

    await vi.waitFor(() => expect(visible(restarted)).toBe(false))
    expect(probe).toHaveBeenCalledOnce()
    expect(restarted.selectTerminalLossResume(PANE, notLive)).toEqual(RESUME)
  })

  it('never probes, or retires as ended, an identity kept for a lost terminal', async () => {
    const server = await startServer()
    await runIdleTurn(server)
    server.clearPaneState(PANE)
    probe.mockResolvedValue('exited')

    expect(server.hasVerifiableAgentProcess(PANE)).toBe(false)
    expect(await server.checkAgentPresence(PANE)).toBeNull()
    expect(probe).not.toHaveBeenCalled()
    expect(server.selectTerminalLossResume(PANE, notLive)).toEqual(RESUME)
  })
})

describe('an identified Claude over the WSL relay', () => {
  async function startPair() {
    const host = await startServer()
    const notices: AgentHookRelayUserEndedSessionEnvelope[] = []
    const relay = new RelayAgentHookServer({
      endpointDir: join(dir, 'relay'),
      forward: (envelope) => host.ingestRemote(envelope, 'wsl:Ubuntu'),
      forwardUserEndedSession: (envelope) => {
        notices.push(envelope)
        host.ingestRemote(envelope, 'wsl:Ubuntu')
      }
    })
    servers.push(relay)
    await relay.start()
    const post = async (payload: Record<string, unknown>): Promise<void> => {
      const { port, token } = relay.getCoordinates()
      const response = await fetch(`http://127.0.0.1:${port}/hook/claude`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Orca-Agent-Hook-Token': token },
        body: JSON.stringify({
          paneKey: PANE,
          tabId: 'tab-1',
          worktreeId: 'wt-1',
          env: 'remote',
          agentProcess: AGENT_PROCESS,
          payload: { session_id: SESSION, transcript_path: TRANSCRIPT, ...payload }
        })
      })
      expect(response.status).toBe(204)
    }
    await post({ hook_event_name: 'SessionStart', source: 'startup' })
    await post({ hook_event_name: 'UserPromptSubmit', prompt: 'ship it' })
    await post({ hook_event_name: 'Stop' })
    return { host, relay, notices, post }
  }

  it('reports a session the user ended, and the host stops resuming it', async () => {
    const pair = await startPair()
    expect(pair.host.selectTerminalLossResume(PANE, notLive)).toEqual(RESUME)

    await pair.post({ hook_event_name: 'SessionEnd', reason: 'prompt_input_exit' })

    expect(pair.notices).toEqual([expect.objectContaining({ userEndedSessionId: SESSION })])
    expect(pair.host.selectTerminalLossResume(PANE, notLive)).toBeNull()
    expect(pair.relay.replayCachedPayloadsForPanes()).toBe(0)
  })

  it('keeps resuming a session a signal ended', async () => {
    const pair = await startPair()

    await pair.post({ hook_event_name: 'SessionEnd', reason: 'other' })

    expect(pair.notices).toEqual([])
    expect(visible(pair.host)).toBe(false)
    expect(pair.host.selectTerminalLossResume(PANE, notLive)).toEqual(RESUME)
  })
})
