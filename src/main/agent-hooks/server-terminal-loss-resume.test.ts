import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makePaneKey } from '../../shared/stable-pane-id'
import { AgentHookServer, _internals } from './server'
import { buildBody, LEAF_2, PANE } from './server.test-fixtures'
import { sweepRestoredSubagentsWithoutLiveAgent } from './restored-subagent-liveness-sweep'

vi.mock('../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../telemetry/cohort-classifier', () => ({ getCohortAtEmit: vi.fn(() => ({})) }))

const SESSION = 'c0ffee00-0000-4000-8000-000000000001'
const OTHER_SESSION = 'c0ffee00-0000-4000-8000-000000000002'
const TRANSCRIPT = '/home/u/.claude/projects/p/c0ffee00.jsonl'
const OTHER_PANE = makePaneKey('tab-2', LEAF_2)
const notLive = (): boolean => false

let dir: string

beforeEach(() => {
  _internals.resetCachesForTests()
  dir = mkdtempSync(join(tmpdir(), 'orca-terminal-loss-resume-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

async function startServer(): Promise<AgentHookServer> {
  const server = new AgentHookServer()
  await server.start({ env: 'production', userDataPath: dir })
  return server
}

async function postClaude(
  server: AgentHookServer,
  payload: Record<string, unknown>,
  paneKey = PANE
): Promise<void> {
  const env = server.buildPtyEnv()
  const tabId = paneKey.split(':')[0]
  const response = await fetch(`http://127.0.0.1:${env.ORCA_AGENT_HOOK_PORT}/hook/claude`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Orca-Agent-Hook-Token': env.ORCA_AGENT_HOOK_TOKEN
    },
    body: JSON.stringify(
      buildBody(
        { session_id: SESSION, transcript_path: TRANSCRIPT, ...payload },
        { paneKey, tabId }
      )
    )
  })
  expect(response.status).toBe(204)
}

async function runIdleTurn(
  server: AgentHookServer,
  paneKey = PANE,
  sessionId = SESSION
): Promise<void> {
  const session = { session_id: sessionId }
  await postClaude(
    server,
    { hook_event_name: 'SessionStart', source: 'startup', ...session },
    paneKey
  )
  await postClaude(
    server,
    { hook_event_name: 'UserPromptSubmit', prompt: 'ship it', ...session },
    paneKey
  )
  await postClaude(server, { hook_event_name: 'Stop', ...session }, paneKey)
}

const RESUME = {
  agent: 'claude',
  providerSession: { key: 'session_id', id: SESSION, transcriptPath: TRANSCRIPT }
}
const OTHER_RESUME = {
  agent: 'claude',
  providerSession: { key: 'session_id', id: OTHER_SESSION, transcriptPath: TRANSCRIPT }
}

describe('resuming an agent whose terminal was lost', () => {
  it('resumes the session an idle agent last reported in the pane', async () => {
    const server = await startServer()
    try {
      await runIdleTurn(server)

      expect(server.selectTerminalLossResume(PANE, notLive)).toEqual(RESUME)
      expect(server.selectTerminalLossResume(OTHER_PANE, notLive)).toBeNull()
    } finally {
      server.stop()
    }
  })

  it('keeps a working agent resumable through PTY teardown without reading it as live', async () => {
    const server = await startServer()
    try {
      await postClaude(server, { hook_event_name: 'UserPromptSubmit', prompt: 'ship it' })

      server.clearPaneState(PANE)

      expect(server.getStatusChangeSnapshot()).toEqual([])
      expect(server.getStatusSnapshotForPane(PANE)).toEqual([
        expect.objectContaining({ providerSessionOnly: true })
      ])
      expect(server.selectTerminalLossResume(PANE, notLive)).toEqual(RESUME)
    } finally {
      server.stop()
    }
  })

  it('keeps both a live row and a lost terminal resumable across a host restart', async () => {
    const first = await startServer()
    await runIdleTurn(first)
    await postClaude(
      first,
      { hook_event_name: 'UserPromptSubmit', prompt: 'x', session_id: OTHER_SESSION },
      OTHER_PANE
    )
    first.reconcileEndedProcessForPaneKeys([OTHER_PANE])
    first.flushStatusPersistSync()
    first.stop()

    const restarted = await startServer()
    try {
      expect(restarted.selectTerminalLossResume(PANE, notLive)).toEqual(RESUME)
      expect(restarted.selectTerminalLossResume(OTHER_PANE, notLive)).toEqual(OTHER_RESUME)
    } finally {
      restarted.stop()
    }
  })

  it('does not resume a session the user ended, before or after its terminal goes', async () => {
    const server = await startServer()
    try {
      await runIdleTurn(server)
      await postClaude(server, { hook_event_name: 'SessionEnd', reason: 'prompt_input_exit' })

      expect(server.selectTerminalLossResume(PANE, notLive)).toBeNull()
      // The identity stays for a manual resume.
      expect(server.getStatusSnapshotForPane(PANE)).toEqual([
        expect.objectContaining({
          providerSessionOnly: true,
          providerSession: RESUME.providerSession
        })
      ])

      server.clearPaneState(PANE)
      server.flushStatusPersistSync()
      server.stop()
      const restarted = await startServer()
      expect(restarted.selectTerminalLossResume(PANE, notLive)).toBeNull()
      restarted.stop()
    } finally {
      server.stop()
    }
  })

  it('keeps resuming a session a signal ended, or one another session in the pane ended', async () => {
    const server = await startServer()
    try {
      await runIdleTurn(server)
      await postClaude(server, { hook_event_name: 'SessionEnd', reason: 'other' })
      await postClaude(server, {
        hook_event_name: 'SessionEnd',
        reason: 'prompt_input_exit',
        session_id: 'nested-session'
      })

      expect(server.getStatusChangeSnapshot()).toEqual([
        expect.objectContaining({ paneKey: PANE, state: 'done' })
      ])
      expect(server.selectTerminalLossResume(PANE, notLive)).toEqual(RESUME)
    } finally {
      server.stop()
    }
  })

  it('does not auto-resume an identity kept after a dismissal or a confirmed shell', async () => {
    const server = await startServer()
    try {
      await runIdleTurn(server)
      await runIdleTurn(server, OTHER_PANE, OTHER_SESSION)
      server.dropStatusEntry(PANE)
      server.reconcileEndedProcessForPaneKeys([OTHER_PANE], { preserveResumeIdentity: true })

      expect(server.selectTerminalLossResume(PANE, notLive)).toBeNull()
      expect(server.selectTerminalLossResume(OTHER_PANE, notLive)).toBeNull()
    } finally {
      server.stop()
    }
  })

  it('gives one conversation to one pane: a live pane keeps it, else the newest pane wins', async () => {
    const server = await startServer()
    try {
      await runIdleTurn(server)
      await runIdleTurn(server, OTHER_PANE)

      expect(server.selectTerminalLossResume(PANE, notLive)).toBeNull()
      expect(server.selectTerminalLossResume(OTHER_PANE, notLive)).toEqual(RESUME)
      expect(server.selectTerminalLossResume(OTHER_PANE, (paneKey) => paneKey === PANE)).toBeNull()
    } finally {
      server.stop()
    }
  })

  it('never resumes a relayed row, whose remote agent may still run', async () => {
    const server = await startServer()
    try {
      server.ingestRemote(
        {
          paneKey: PANE,
          tabId: 'tab-1',
          source: 'claude',
          hookEventName: 'Stop',
          providerSession: { key: 'session_id', id: SESSION },
          payload: { state: 'done', prompt: 'ship it', agentType: 'claude' }
        },
        'ssh-conn'
      )

      expect(server.selectTerminalLossResume(PANE, notLive)).toBeNull()
    } finally {
      server.stop()
    }
  })

  it('does not read a new agent in a pane whose agent was lost as that agent', async () => {
    const server = await startServer()
    try {
      await postClaude(server, { hook_event_name: 'UserPromptSubmit', prompt: 'ship it' })
      server.clearPaneState(PANE)

      server.ingestTerminalStatus({
        paneKey: PANE,
        tabId: 'tab-1',
        connectionId: null,
        payload: { state: 'working', prompt: 'new work', agentType: 'codex' }
      })

      expect(server.getStatusSnapshotForPane(PANE)).toEqual([
        expect.objectContaining({ agentType: 'codex', state: 'working' })
      ])
    } finally {
      server.stop()
    }
  })

  it('keeps a working agent resumable when the boot sweep finds its PTY gone', async () => {
    const first = await startServer()
    await postClaude(first, { hook_event_name: 'UserPromptSubmit', prompt: 'ship it' })
    first.flushStatusPersistSync()
    first.stop()
    const restarted = await startServer()
    try {
      const reaped = await sweepRestoredSubagentsWithoutLiveAgent({
        probeLiveLocalPty: async () => false,
        isLocalExecutionHost: () => true,
        getBoundPtyIdForPaneKey: () => undefined,
        getPersistedPtyIdForPaneKey: (paneKey) => (paneKey === PANE ? 'pty-1' : undefined),
        reap: (isLocalHost, isLive, isCurrent) =>
          restarted.reapRestoredClaudeSubagentsWithoutLiveAgent(isLocalHost, isLive, isCurrent)
      })

      expect(reaped).toBe(1)
      expect(restarted.getStatusChangeSnapshot()).toEqual([])
      expect(restarted.selectTerminalLossResume(PANE, notLive)).toEqual(RESUME)
      // A retained identity asserts nothing, so a second sweep has nothing to do.
      expect(
        await restarted.reapRestoredClaudeSubagentsWithoutLiveAgent(
          () => true,
          async () => false,
          () => true
        )
      ).toBe(0)
    } finally {
      restarted.stop()
    }
  })
})
