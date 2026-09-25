/**
 * The auto-resume gate reads two timestamps the connect path writes from xterm's onData stream:
 * `lastTerminalInputAt` (any accepted write) and `lastRealUserInputAt` (keystrokes, IME, paste).
 * After the restart the feature exists for, the first bytes a fresh shell receives are often SGR
 * mouse reports from the dead agent's still-armed tracking, and xterm flags those as user input.
 * This drives the real onData path and pins which timestamp each kind of input moves.
 */
import type * as React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushAsyncTicks } from './pty-connection-test-async'
import { sendTerminalInputThroughPane } from './pty-connection-test-dom'
import {
  createMockTransport,
  createPane,
  createManager,
  type MockPane,
  type MockTransport
} from './pty-connection-test-pane-fixtures'
import { buildPaneConnectionDeps } from './pty-connection-test-deps'
import type { connectPanePty } from './pty-connection'
import type { ConnectPanePtySession } from './pty-connection/connect-pane-pty-session'
import { createInitialStoreState } from './pty-connection-test-store-fixtures'
import type { StoreState } from './pty-connection-test-store-state'
import {
  installTerminalTestGlobals,
  restoreTerminalTestGlobals
} from './pty-connection-test-environment'

const { scheduleRuntimeGraphSync, notifyCodexPaneBoundForStaleSweep, toastInfo, sessions } =
  vi.hoisted(() => {
    const sessions: ConnectPanePtySession[] = []
    return {
      scheduleRuntimeGraphSync: vi.fn(),
      notifyCodexPaneBoundForStaleSweep: vi.fn(),
      toastInfo: vi.fn(),
      sessions
    }
  })

let mockStoreState: StoreState
let transportFactoryQueue: MockTransport[] = []

vi.mock('@/runtime/sync-runtime-graph', () => ({ scheduleRuntimeGraphSync }))
vi.mock('@/lib/codex-stale-pane-sweep', () => ({ notifyCodexPaneBoundForStaleSweep }))
vi.mock('sonner', () => ({ toast: { info: toastInfo } }))

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => mockStoreState,
    subscribe: () => () => {}
  }
}))

vi.mock('@/lib/agent-status', async (importOriginal) => {
  const { buildAgentStatusModuleMock } = await import('./pty-connection-test-environment')
  return buildAgentStatusModuleMock(await importOriginal<Record<string, unknown>>())
})

// Why: connectPanePty calls hooks outside React here; no test in this file renders.
vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof React>()
  return {
    ...actual,
    useCallback: <T extends (...args: unknown[]) => unknown>(fn: T): T => fn
  }
})

vi.mock('./pty-transport', () => ({
  createIpcPtyTransport: vi.fn(() => {
    const next = transportFactoryQueue.shift()
    if (!next) {
      throw new Error('No mock transport queued')
    }
    return next
  })
}))

vi.mock('./remote-runtime-pty-transport', () => ({
  createRemoteRuntimePtyTransport: vi.fn(() => {
    const next = transportFactoryQueue.shift()
    if (!next) {
      throw new Error('No mock transport queued')
    }
    return next
  })
}))

// The session bag is internal to connectPanePty; the gate's installer is the one reader of the
// timestamps under test, so wrapping it is the narrowest way to observe them.
vi.mock('./pty-connection/agent-resume-recovery-install', async (importOriginal) => {
  const actual = await importOriginal<{
    installAgentResumeRecovery: (session: ConnectPanePtySession) => void
  }>()
  return {
    installAgentResumeRecovery: (session: ConnectPanePtySession) => {
      sessions.push(session)
      actual.installAgentResumeRecovery(session)
    }
  }
})

/** xterm's onUserInput fires before onData for keystrokes, IME, paste AND mouse reports. */
function wireUserInputProvenance(pane: MockPane): (data: string, wasUserInput: boolean) => void {
  const userInputListeners: (() => void)[] = []
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fixture terminal is a plain mock object; this adds the one core-internal seam subscribeToTerminalUserInput reads.
  ;(pane.terminal as unknown as Record<string, unknown>)._core = {
    coreService: {
      onUserInput: (listener: () => void) => {
        userInputListeners.push(listener)
        return { dispose: vi.fn() }
      }
    }
  }
  return (data, wasUserInput) => {
    if (wasUserInput) {
      for (const listener of userInputListeners) {
        listener()
      }
    }
    sendTerminalInputThroughPane(pane, data)
  }
}

async function connectFreshShell(connect: typeof connectPanePty): Promise<{
  session: ConnectPanePtySession
  emit: (data: string, wasUserInput: boolean) => void
}> {
  const pane = createPane(1)
  const emit = wireUserInputProvenance(pane)
  transportFactoryQueue.push(createMockTransport())
  const deps = buildPaneConnectionDeps(() => mockStoreState)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: createPane, createManager and buildPaneConnectionDeps are this directory's shared connectPanePty fixtures; every other test here drives the same function with them.
  connect(pane as never, createManager(1) as never, deps as never)
  await flushAsyncTicks()
  const session = sessions.at(-1)
  if (!session) {
    throw new Error('connectPanePty did not install the resume gate')
  }
  expect(session.userInputActivityDisposable).not.toBeNull()
  return { session, emit }
}

describe('what counts as the user typing, through the real onData path', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    sessions.length = 0
    transportFactoryQueue = []
    mockStoreState = createInitialStoreState(() => mockStoreState)
    installTerminalTestGlobals()
  })

  afterEach(async () => {
    await restoreTerminalTestGlobals()
  })

  it('leaves the keystroke timestamp untouched by mouse reports, focus reports and query replies', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const { session, emit } = await connectFreshShell(connectPanePty)
    expect(Number.isFinite(session.lastTerminalInputAt)).toBe(false)
    expect(Number.isFinite(session.lastRealUserInputAt)).toBe(false)

    // The symptom from the restart: `35;34;1M` typed into bash on every pointer move.
    emit('\x1b[<35;34;1M', true)
    emit('\x1b[<0;12;3M', true)
    emit('\x1b[I', false)
    emit('\x1b[O', false)
    emit('\x1b[?1;2c', false)

    expect(Number.isFinite(session.lastTerminalInputAt)).toBe(true)
    expect(Number.isFinite(session.lastRealUserInputAt)).toBe(false)
  })

  it.each([
    ['a keystroke', 'a'],
    ['an arrow key', '\x1b[A'],
    ['a paste', '\x1b[200~ls\x1b[201~']
  ])('records %s as the user claiming the shell', async (_label, data) => {
    const { connectPanePty } = await import('./pty-connection')
    const { session, emit } = await connectFreshShell(connectPanePty)

    emit(data, true)

    expect(Number.isFinite(session.lastRealUserInputAt)).toBe(true)
    expect(Number.isFinite(session.lastTerminalInputAt)).toBe(true)
  })
})
