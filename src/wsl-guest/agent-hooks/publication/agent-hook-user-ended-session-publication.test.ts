import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RelayDispatcher } from '../../transport/publication/dispatcher'
import type { RelayClientSinkOptions } from '../../transport/writer/dispatcher-writer-sink'
import {
  publishAgentHookEnvelope,
  publishAgentHookUserEndedSession
} from './agent-hook-envelope-publication'
import {
  AGENT_HOOK_NOTIFICATION_METHOD,
  AGENT_HOOK_USER_ENDED_SESSION_STATE,
  type AgentHookRelayEnvelope,
  type AgentHookRelayUserEndedSessionEnvelope
} from '../../../shared/agent-hook-listener/transport/agent-hook-relay'

type BoundedClient = {
  frames: Buffer[]
  options: RelayClientSinkOptions
  write: (data: Buffer) => boolean
  /** Mimics a socket whose kernel buffer is full: writes are accepted but never settle. */
  blocked: boolean
  drain: () => void
}

function makeBoundedClient(highWaterMark: number): BoundedClient {
  const drainListeners = new Set<() => void>()
  const client: BoundedClient = {
    frames: [],
    blocked: false,
    write: (data: Buffer) => {
      client.frames.push(Buffer.from(data))
      return !client.blocked
    },
    drain: () => {
      for (const listener of Array.from(drainListeners)) {
        drainListeners.delete(listener)
        listener()
      }
    },
    options: {
      writableHighWaterMark: () => highWaterMark,
      writableLength: () => 0,
      waitWriteDrain: (callback: () => void) => {
        drainListeners.add(callback)
        return () => drainListeners.delete(callback)
      }
    }
  }
  return client
}

/** Fills the producer queue so the next publish is rejected for backpressure, not for frame size. */
function saturateProducerQueue(dispatcher: RelayDispatcher, client: BoundedClient): void {
  client.blocked = true
  // Shrinking chunks close the headroom a rejected 8 KB frame leaves behind.
  for (const size of [8_000, 512, 16]) {
    const data = 'x'.repeat(size)
    let filled = false
    for (let attempt = 0; attempt < 5_000 && !filled; attempt++) {
      filled = !dispatcher.tryNotifyPtyData({ id: 'pty-1', data })
    }
    if (!filled) {
      throw new Error('producer queue never filled')
    }
  }
}

function decodeHookParams(client: BoundedClient): unknown[] {
  // Keepalive frames carry no payload; only regular frames decode as JSON-RPC.
  return client.frames
    .filter((frame) => frame.readUInt32BE(9) > 0)
    .map((frame): { method?: unknown; params?: unknown } =>
      JSON.parse(frame.subarray(13, 13 + frame.readUInt32BE(9)).toString('utf-8'))
    )
    .filter((message) => message.method === AGENT_HOOK_NOTIFICATION_METHOD)
    .map((message) => message.params)
}

const PANE_KEY = 'tab-1:4f1b0f4e-0000-4000-8000-000000000001'

const notice: AgentHookRelayUserEndedSessionEnvelope = {
  source: 'claude',
  paneKey: PANE_KEY,
  connectionId: null,
  hookEventName: 'SessionEnd',
  userEndedSessionId: 'session-1',
  reportsUserEndedSessions: true,
  payload: { state: AGENT_HOOK_USER_ENDED_SESSION_STATE }
}

const doneSnapshot: AgentHookRelayEnvelope = {
  source: 'claude',
  paneKey: PANE_KEY,
  connectionId: null,
  worktreeId: 'worktree-1',
  payload: {
    state: 'done',
    prompt: 'p'.repeat(64),
    agentType: 'claude',
    model: 'claude-opus',
    toolName: 'Bash',
    toolInput: 'echo hi'
  }
}

describe('publishAgentHookUserEndedSession', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("supersedes the pane's waiting snapshot, which would otherwise land after it", () => {
    const primary = makeBoundedClient(16384)
    const dispatcher = new RelayDispatcher(primary.write, primary.options)
    try {
      saturateProducerQueue(dispatcher, primary)
      publishAgentHookEnvelope(dispatcher, doneSnapshot)

      primary.blocked = false
      primary.drain()
      publishAgentHookUserEndedSession(dispatcher, notice)
      vi.advanceTimersByTime(10_000)

      expect(decodeHookParams(primary)).toEqual([expect.objectContaining(notice)])
    } finally {
      dispatcher.dispose()
    }
  })

  it('is redelivered when the producer queue rejects it', () => {
    const primary = makeBoundedClient(16384)
    const dispatcher = new RelayDispatcher(primary.write, primary.options)
    try {
      saturateProducerQueue(dispatcher, primary)
      publishAgentHookUserEndedSession(dispatcher, notice)
      expect(decodeHookParams(primary)).toHaveLength(0)

      primary.blocked = false
      primary.drain()
      vi.advanceTimersByTime(250)

      expect(decodeHookParams(primary)).toEqual([expect.objectContaining(notice)])
    } finally {
      dispatcher.dispose()
    }
  })
})
