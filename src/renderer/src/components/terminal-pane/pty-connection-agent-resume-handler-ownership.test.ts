/**
 * The chooser reaches a pane through `registerAgentResumePaneHandler`, and the owner it names is
 * the pty binding's transport. Every other test in this area hands the installer a session bag that
 * already has a `transport`, so none of them can see the install ORDER that `connectPanePty`
 * actually uses — and while the registration ran before the transport existed, the handler sat
 * under owner `undefined` and every Enter, number key and click silently did nothing.
 *
 * So this binds through the real sequence and asserts the two owners agree.
 */
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
import type { connectPanePty } from './pty-connection'
import { createInitialStoreState } from './pty-connection-test-store-fixtures'
import type { StoreState } from './pty-connection-test-store-state'
import {
  installTerminalTestGlobals,
  restoreTerminalTestGlobals
} from './pty-connection-test-environment'

const { scheduleRuntimeGraphSync, notifyCodexPaneBoundForStaleSweep, toastInfo } = vi.hoisted(
  () => ({
    scheduleRuntimeGraphSync: vi.fn(),
    notifyCodexPaneBoundForStaleSweep: vi.fn(),
    toastInfo: vi.fn()
  })
)

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

/** Drives the real connect path with this directory's shared pty fixtures. One place carries the
 *  fixture-to-signature cast so the assertions below stay about ownership. */
function connectWithFixtures(
  connect: typeof connectPanePty
): ReturnType<typeof buildPaneConnectionDeps> {
  const deps = buildPaneConnectionDeps(() => mockStoreState)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: createPane, createManager and buildPaneConnectionDeps are this directory's shared connectPanePty fixtures; every other test here drives the same function with them, and they supply every field it reads.
  connect(createPane(1) as never, createManager(1) as never, deps as never)
  return deps
}

describe('agent resume pane handler ownership, through the real connect sequence', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    transportFactoryQueue = []
    mockStoreState = createInitialStoreState(() => mockStoreState)
    installTerminalTestGlobals()
  })

  afterEach(async () => {
    await restoreTerminalTestGlobals()
  })

  it('registers the resume handler under the transport the chooser publishes choices with', async () => {
    // Why the dynamic import: `vi.resetModules()` gives each test a fresh registry instance, and a
    // file-level import would read the previous one — the handler under test would never appear.
    const { connectPanePty } = await import('./pty-connection')
    const { getAgentResumePaneHandler } = await import('@/lib/agent-resume-pane-handlers')
    const transport = createMockTransport()
    transportFactoryQueue.push(transport)
    const deps = connectWithFixtures(connectPanePty)
    await flushAsyncTicks()

    const paneKey = makePaneKey(deps.tabId, leafIdForPane(1))
    // `setPendingAgentResumeChoices` stamps a choice with this same transport, so a handler the
    // lookup cannot find under it is a chooser no keystroke can reach.
    expect(getAgentResumePaneHandler(paneKey, transport)).toBeTypeOf('function')
    expect(getAgentResumePaneHandler(paneKey, {})).toBeUndefined()
  })

  it('leaves no handler registered under an absent owner', async () => {
    const { connectPanePty } = await import('./pty-connection')
    const { getAgentResumePaneHandler } = await import('@/lib/agent-resume-pane-handlers')
    transportFactoryQueue.push(createMockTransport())
    const deps = connectWithFixtures(connectPanePty)
    await flushAsyncTicks()

    const paneKey = makePaneKey(deps.tabId, leafIdForPane(1))
    // The install-order defect: `session.transport` was still undefined at registration time.
    expect(getAgentResumePaneHandler(paneKey, undefined)).toBeUndefined()
  })
})
