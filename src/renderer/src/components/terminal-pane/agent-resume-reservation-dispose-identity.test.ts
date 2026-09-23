import type * as React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import { flushAsyncTicks } from './pty-connection-test-async'
import {
  createMockTransport,
  createPane,
  createManager,
  leafIdForPane,
  type MockTransport
} from './pty-connection-test-pane-fixtures'
import { buildPaneConnectionDeps } from './pty-connection-test-deps'
import type * as AgentResumeSessionReservations from '@/lib/agent-resume-session-reservations'
import { createInitialStoreState } from './pty-connection-test-store-fixtures'
import type { StoreState } from './pty-connection-test-store-state'
import {
  installTerminalTestGlobals,
  restoreTerminalTestGlobals
} from './pty-connection-test-environment'

const { scheduleRuntimeGraphSync, notifyCodexPaneBoundForStaleSweep } = vi.hoisted(() => ({
  scheduleRuntimeGraphSync: vi.fn(),
  notifyCodexPaneBoundForStaleSweep: vi.fn()
}))

let mockStoreState: StoreState
let transportFactoryQueue: MockTransport[] = []
let storeSubscribers: ((state: StoreState) => void)[] = []

vi.mock('@/runtime/sync-runtime-graph', () => ({ scheduleRuntimeGraphSync }))
vi.mock('@/lib/codex-stale-pane-sweep', () => ({ notifyCodexPaneBoundForStaleSweep }))

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => mockStoreState,
    subscribe: (listener: (state: StoreState) => void) => {
      storeSubscribers.push(listener)
      return () => {
        storeSubscribers = storeSubscribers.filter((candidate) => candidate !== listener)
      }
    }
  }
}))

vi.mock('@/lib/agent-status', async (importOriginal) => {
  const { buildAgentStatusModuleMock } = await import('./pty-connection-test-environment')
  return buildAgentStatusModuleMock(await importOriginal<Record<string, unknown>>())
})

// Why: connectPanePty calls hooks outside React; only useCallback needs to pass through.
vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof React>()
  return {
    ...actual,
    useCallback: <T extends (...args: unknown[]) => unknown>(fn: T): T => fn
  }
})

vi.mock('./pty-transport', () => ({
  createIpcPtyTransport: vi.fn(() => {
    const nextTransport = transportFactoryQueue.shift()
    if (!nextTransport) {
      throw new Error('No mock transport queued')
    }
    return nextTransport
  })
}))

const SESSION_ID = 'a521d69e-9181-481c-ab8e-998a1881b731'
const PANE_KEY = makePaneKey('tab-1', leafIdForPane(1))

/**
 * A retired binding's dispose must not release a resume reservation, because the reservation
 * lives under the STABLE pane key its successor also uses. Releasing a successor's reservation
 * reopens the window where two panes resume one transcript and fork it.
 */
describe('agent resume reservations across a pane binding replacement', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    transportFactoryQueue = []
    storeSubscribers = []
    mockStoreState = createInitialStoreState(() => mockStoreState)
    installTerminalTestGlobals()
  })

  afterEach(async () => {
    await restoreTerminalTestGlobals()
  })

  /** Why imported here: `vi.resetModules()` gives each test a fresh module registry, so the
   *  reservation store the pane writes to is only the same one the assertions read when both
   *  come from this import. */
  async function connectPane(): Promise<{
    deps: ReturnType<typeof buildPaneConnectionDeps>
    dispose: () => void
    reservations: typeof AgentResumeSessionReservations
  }> {
    const { connectPanePty } = await import('./pty-connection')
    const transport = createMockTransport('pty-id')
    transportFactoryQueue.push(transport)
    const deps = buildPaneConnectionDeps(() => mockStoreState, {
      isVisibleRef: { current: true }
    })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the shared pane/manager/deps fixtures model exactly the surface connectPanePty reads; every connect test in this directory passes them through the same casts.
    const binding = connectPanePty(createPane(1) as never, createManager(1) as never, deps as never)
    await flushAsyncTicks(6)
    return {
      deps,
      dispose: () => binding.dispose(),
      reservations: await import('@/lib/agent-resume-session-reservations')
    }
  }

  it('keeps a reservation a successor binding holds', async () => {
    const { deps, dispose, reservations } = await connectPane()
    reservations.reserveAgentResumeSession(SESSION_ID, PANE_KEY)
    // A successor connection claimed this pane slot before the retired binding tore down.
    deps.paneTransportsRef.current.set(1, { successor: true })

    dispose()

    expect(reservations.agentResumeSessionsReservedElsewhere('other-pane')).toContain(SESSION_ID)
  })

  it('releases its own reservation when it still owns the pane', async () => {
    const { dispose, reservations } = await connectPane()
    reservations.reserveAgentResumeSession(SESSION_ID, PANE_KEY)

    dispose()

    expect(reservations.agentResumeSessionsReservedElsewhere('other-pane')).not.toContain(
      SESSION_ID
    )
  })
})
