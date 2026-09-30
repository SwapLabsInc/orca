import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RelayAgentHookServer } from '../../relay/agent-hook-server'
import type {
  AgentHookRelayEnvelope,
  AgentHookRelayUserEndedSessionEnvelope
} from '../../shared/agent-hook-relay'
import { normalizeAgentStatusPayload } from '../../shared/agent-status-types'
import { AgentHookServer, _internals } from './server'
import { PANE } from './server.test-fixtures'

vi.mock('../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../telemetry/cohort-classifier', () => ({ getCohortAtEmit: vi.fn(() => ({})) }))

const WSL = 'wsl:Ubuntu'
const SESSION = 'c0ffee00-0000-4000-8000-000000000001'
const TRANSCRIPT = '/home/u/.claude/projects/p/c0ffee00.jsonl'
const RESUME = {
  agent: 'claude',
  providerSession: { key: 'session_id', id: SESSION, transcriptPath: TRANSCRIPT }
}
const notLive = (): boolean => false

type RelayEnvelope = AgentHookRelayEnvelope | AgentHookRelayUserEndedSessionEnvelope

let dir: string

beforeEach(() => {
  _internals.resetCachesForTests()
  dir = mkdtempSync(join(tmpdir(), 'orca-wsl-user-ended-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/**
 * A WSL relay feeding a host the way production wires them (`wsl-agent-hook-relay.ts` and
 * `wsl-hook-relay-deps.ts`). `relayReports: false` is a relay that predates user-ended notices;
 * `hostReads: false` is a host that predates them, which ignores the fields it has never heard of.
 */
async function startPair(options: { relayReports: boolean; hostReads: boolean }) {
  const host = new AgentHookServer()
  await host.start({ env: 'production', userDataPath: join(dir, 'host') })
  const wire: RelayEnvelope[] = []
  const toHost = (envelope: RelayEnvelope): void => {
    wire.push(envelope)
    host.ingestRemote(options.hostReads ? envelope : withoutNewFields(envelope), WSL)
  }
  const relay = new RelayAgentHookServer({
    endpointDir: join(dir, 'relay'),
    forward: toHost,
    ...(options.relayReports ? { forwardUserEndedSession: toHost } : {})
  })
  await relay.start()
  const post = async (payload: Record<string, unknown>, launchToken?: string): Promise<void> => {
    const { port, token } = relay.getCoordinates()
    const response = await fetch(`http://127.0.0.1:${port}/hook/claude`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Orca-Agent-Hook-Token': token },
      body: JSON.stringify({
        paneKey: PANE,
        tabId: 'tab-1',
        worktreeId: 'wt-1',
        env: 'remote',
        ...(launchToken ? { launchToken } : {}),
        payload: { session_id: SESSION, transcript_path: TRANSCRIPT, ...payload }
      })
    })
    expect(response.status).toBe(204)
  }
  const runIdleTurn = async (launchToken?: string): Promise<void> => {
    await post({ hook_event_name: 'SessionStart', source: 'startup' }, launchToken)
    await post({ hook_event_name: 'UserPromptSubmit', prompt: 'ship it' }, launchToken)
    await post({ hook_event_name: 'Stop' }, launchToken)
  }
  const stop = (): void => {
    relay.stop()
    host.stop()
  }
  return { host, relay, wire, post, runIdleTurn, stop }
}

/** What a host that predates user-ended notices reads: every field it has not heard of is ignored. */
function withoutNewFields(envelope: RelayEnvelope): Parameters<AgentHookServer['ingestRemote']>[0] {
  const { reportsUserEndedSessions: _capability, ...older } = envelope
  if ('userEndedSessionId' in older) {
    const { userEndedSessionId: _notice, ...olderNotice } = older
    return olderNotice
  }
  return older
}

function notices(wire: RelayEnvelope[]): AgentHookRelayUserEndedSessionEnvelope[] {
  return wire.filter(
    (envelope): envelope is AgentHookRelayUserEndedSessionEnvelope =>
      'userEndedSessionId' in envelope
  )
}

describe('a user-ended Claude session over the WSL relay', () => {
  for (const reason of ['prompt_input_exit', 'logout']) {
    it(`stops resuming a session the user ended with ${reason}`, async () => {
      const pair = await startPair({ relayReports: true, hostReads: true })
      try {
        await pair.runIdleTurn('launch-1')
        expect(pair.wire.every((envelope) => envelope.reportsUserEndedSessions === true)).toBe(true)
        expect(pair.host.selectTerminalLossResume(PANE, notLive)).toEqual(RESUME)

        await pair.post({ hook_event_name: 'SessionEnd', reason }, 'launch-1')

        expect(notices(pair.wire)).toEqual([
          expect.objectContaining({
            source: 'claude',
            paneKey: PANE,
            launchToken: 'launch-1',
            hookEventName: 'SessionEnd',
            userEndedSessionId: SESSION,
            reportsUserEndedSessions: true
          })
        ])
        expect(pair.host.selectTerminalLossResume(PANE, notLive)).toBeNull()
        // The identity stays for a manual resume, and the relay has nothing left to replay.
        expect(pair.host.getStatusSnapshotForPane(PANE)).toEqual([
          expect.objectContaining({ providerSessionOnly: true })
        ])
        expect(pair.relay.replayCachedPayloadsForPanes()).toBe(0)
      } finally {
        pair.stop()
      }
    })
  }

  it('ignores a late SessionEnd from the launch a resume replaced', async () => {
    const pair = await startPair({ relayReports: true, hostReads: true })
    try {
      await pair.post({ hook_event_name: 'SessionStart', source: 'startup' }, 'launch-old')
      await pair.post({ hook_event_name: 'SessionStart', source: 'resume' }, 'launch-new')
      await pair.post({ hook_event_name: 'Stop' }, 'launch-new')
      await pair.post({ hook_event_name: 'SessionEnd', reason: 'prompt_input_exit' }, 'launch-old')

      expect(notices(pair.wire)).toHaveLength(1)
      expect(pair.host.selectTerminalLossResume(PANE, notLive)).toEqual(RESUME)
      expect(pair.relay.replayCachedPayloadsForPanes()).toBe(1)
    } finally {
      pair.stop()
    }
  })

  it('keeps resuming after a signal or a nested session ends', async () => {
    const pair = await startPair({ relayReports: true, hostReads: true })
    try {
      await pair.runIdleTurn()
      await pair.post({ hook_event_name: 'SessionEnd', reason: 'other' })
      await pair.post({
        hook_event_name: 'SessionEnd',
        reason: 'prompt_input_exit',
        session_id: 'nested-session'
      })

      expect(notices(pair.wire).map((notice) => notice.userEndedSessionId)).toEqual([
        'nested-session'
      ])
      expect(pair.host.selectTerminalLossResume(PANE, notLive)).toEqual(RESUME)
      expect(pair.relay.replayCachedPayloadsForPanes()).toBe(1)
    } finally {
      pair.stop()
    }
  })

  it('reports a SessionEnd the CLI spooled while the relay was down', async () => {
    const spoolDir = join(dir, 'relay', 'spool')
    mkdirSync(spoolDir, { recursive: true })
    writeFileSync(
      join(spoolDir, 'pane-claude.jsonl'),
      `${JSON.stringify({
        paneKey: PANE,
        tabId: 'tab-1',
        env: 'remote',
        hookEventName: 'SessionEnd',
        source: 'claude',
        payload: {
          hook_event_name: 'SessionEnd',
          reason: 'prompt_input_exit',
          session_id: SESSION
        },
        receivedAt: Date.now()
      })}\n`
    )
    const pair = await startPair({ relayReports: true, hostReads: true })
    try {
      expect(notices(pair.wire)).toEqual([
        expect.objectContaining({ userEndedSessionId: SESSION, isReplay: true })
      ])
    } finally {
      pair.stop()
    }
  })
})

describe('mixed relay and host versions', () => {
  it('does not resume a WSL row from a relay that cannot report a user-ended session', async () => {
    const pair = await startPair({ relayReports: false, hostReads: true })
    try {
      await pair.runIdleTurn()
      await pair.post({ hook_event_name: 'SessionEnd', reason: 'prompt_input_exit' })

      expect(pair.wire.some((envelope) => envelope.reportsUserEndedSessions)).toBe(false)
      expect(notices(pair.wire)).toEqual([])
      expect(pair.host.getStatusSnapshotForPane(PANE)).toEqual([
        expect.objectContaining({ state: 'done' })
      ])
      expect(pair.host.selectTerminalLossResume(PANE, notLive)).toBeNull()
    } finally {
      pair.stop()
    }
  })

  it("keeps a host that predates the notice on the relay's status rows and drops the notice", async () => {
    const pair = await startPair({ relayReports: true, hostReads: false })
    try {
      await pair.runIdleTurn()
      const before = pair.host.getStatusSnapshotForPane(PANE)
      expect(before).toEqual([expect.objectContaining({ state: 'done' })])

      await pair.post({ hook_event_name: 'SessionEnd', reason: 'prompt_input_exit' })

      const [notice] = notices(pair.wire)
      expect(normalizeAgentStatusPayload(notice!.payload)).toBeNull()
      expect(pair.host.getStatusSnapshotForPane(PANE)).toEqual(before)
    } finally {
      pair.stop()
    }
  })
})
