import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createRemoteRuntimeTransportMocks,
  type MultiplexSubscriptionCallbacks
} from './remote-runtime-pty-transport-test-harness'

let subscriptionCallbacks: MultiplexSubscriptionCallbacks = null
let resolvedPaneHandle = 'terminal-1'

const {
  runtimeCall,
  subscriptionSendBinary,
  latestSubscribePayload,
  subscribedTerminalHandles,
  emitSnapshot,
  resetRemoteRuntimeTransport
} = createRemoteRuntimeTransportMocks({
  getCallbacks: () => subscriptionCallbacks,
  setCallbacks: (callbacks) => {
    subscriptionCallbacks = callbacks
  },
  getResolvedPaneHandle: () => resolvedPaneHandle,
  setResolvedPaneHandle: (handle) => {
    resolvedPaneHandle = handle
  }
})

/** The host re-created the pane after its terminal was lost: `surface` names what now backs it. */
function hostPublishes(surface: { terminal: string; incarnationId?: string }): void {
  runtimeCall.mockImplementation(async (request: { method: string; params?: unknown }) => {
    if (request.method !== 'session.tabs.activate' && request.method !== 'session.tabs.list') {
      return { ok: true, result: {} }
    }
    return {
      ok: true,
      result: {
        worktree: 'wt-1',
        publicationEpoch: 'epoch-1',
        snapshotVersion: 1,
        activeGroupId: null,
        activeTabId: 'host-tab-1::pane:1',
        activeTabType: 'terminal',
        tabs: [
          {
            type: 'terminal',
            id: 'host-tab-1::pane:1',
            parentTabId: 'host-tab-1',
            leafId: 'pane:1',
            title: 'Terminal',
            isActive: true,
            status: 'ready',
            ...surface
          }
        ]
      }
    }
  })
}

async function recoverOnto(
  before: { terminal: string; incarnationId?: string },
  after: { terminal: string; incarnationId?: string }
): Promise<{ onProcessReplaced: ReturnType<typeof vi.fn>; handlesAtReset: string[][] }> {
  const { createRemoteRuntimePtyTransport } = await import('./remote-runtime-pty-transport')
  const handlesAtReset: string[][] = []
  const onProcessReplaced = vi.fn(() => handlesAtReset.push(subscribedTerminalHandles()))
  hostPublishes(before)
  const transport = createRemoteRuntimePtyTransport('env-1', {
    worktreeId: 'wt-1',
    tabId: 'web-terminal-host-tab-1',
    leafId: 'pane:1'
  })
  await transport.connect({ url: '', cols: 80, rows: 24, callbacks: { onProcessReplaced } })
  await vi.waitFor(() => expect(subscriptionSendBinary).toHaveBeenCalled())
  const firstStreamId = latestSubscribePayload().streamId
  emitSnapshot(firstStreamId, 'claude')

  hostPublishes(after)
  subscriptionCallbacks?.onResponse({
    ok: true,
    result: { type: 'end', streamId: firstStreamId, code: 0 }
  })
  // Why the long wait: a same-handle end first waits out the host's replacement window.
  await vi.waitFor(() => expect(subscribedTerminalHandles()).toHaveLength(2), { timeout: 20_000 })
  expect(subscribedTerminalHandles().at(-1)).toBe(after.terminal)
  return { onProcessReplaced, handlesAtReset }
}

describe('remote runtime pane recovery onto a replacement process', () => {
  beforeEach(() => {
    resetRemoteRuntimeTransport()
  })

  it('grounds the modes the lost process armed before the replacement paints', async () => {
    const { onProcessReplaced, handlesAtReset } = await recoverOnto(
      { terminal: 'terminal-1', incarnationId: 'incarnation-1' },
      { terminal: 'terminal-2', incarnationId: 'incarnation-2' }
    )

    expect(onProcessReplaced).toHaveBeenCalledOnce()
    expect(handlesAtReset).toEqual([['terminal-1']])
  })

  it('keeps the modes of a live process whose handle was re-minted', async () => {
    const { onProcessReplaced } = await recoverOnto(
      { terminal: 'terminal-1', incarnationId: 'incarnation-1' },
      { terminal: 'terminal-2', incarnationId: 'incarnation-1' }
    )

    expect(onProcessReplaced).not.toHaveBeenCalled()
  })

  it('grounds the modes when the host re-created the process behind the same handle', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    try {
      const { onProcessReplaced } = await recoverOnto(
        { terminal: 'terminal-1', incarnationId: 'incarnation-1' },
        { terminal: 'terminal-1', incarnationId: 'incarnation-2' }
      )

      expect(onProcessReplaced).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
    }
  })

  it('changes nothing for a host that does not name its processes', async () => {
    const { onProcessReplaced } = await recoverOnto(
      { terminal: 'terminal-1' },
      { terminal: 'terminal-2' }
    )

    expect(onProcessReplaced).not.toHaveBeenCalled()
  })
})
