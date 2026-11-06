import { beforeEach, expect, it, vi } from 'vitest'

type Handler = (event: unknown, args?: unknown) => Promise<unknown>
type MockAdapter = {
  protocolVersion: number
  listSessions: ReturnType<typeof vi.fn>
  shutdown: ReturnType<typeof vi.fn>
}

const { handlers, adapters } = vi.hoisted(() => {
  const adapters: MockAdapter[] = []
  return { handlers: new Map<string, Handler>(), adapters }
})

vi.mock('electron', () => ({
  ipcMain: {
    removeHandler: (name: string) => handlers.delete(name),
    handle: (name: string, handler: Handler) => handlers.set(name, handler)
  }
}))
vi.mock('../../daemon/providers/lifecycle/daemon-provider-state', () => ({
  getDaemonProvider: () => ({})
}))
vi.mock('../../daemon/providers/lifecycle/daemon-provider-routing', () => ({
  getAllDaemonAdapters: () => adapters,
  getCurrentDaemonAdapter: () => adapters[0]
}))
vi.mock('../../daemon/providers/lifecycle/daemon-provider-restart', () => ({
  restartDaemon: vi.fn()
}))

import { registerDaemonManagementHandlers } from './pty-management'

function makeAdapter(protocolVersion: number, sessionId: string): MockAdapter {
  return {
    protocolVersion,
    listSessions: vi.fn(async () => [{ sessionId, state: 'running', isAlive: true }]),
    shutdown: vi.fn(async () => {})
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  adapters.length = 0
})

// LOCAL: a drained daemon (#25) shares the current one's protocol version, so the version alone
// cannot say which adapter owns a session.
it('routes killOne to a drained daemon that shares the current protocol version', async () => {
  const current = makeAdapter(5, 'new-1')
  const drained = makeAdapter(5, 'kept-1')
  adapters.push(current, drained)
  registerDaemonManagementHandlers()

  const result = await handlers.get('pty:management:killOne')?.({}, { sessionId: 'kept-1' })

  expect(result).toEqual({ success: true })
  expect(drained.shutdown).toHaveBeenCalledWith('kept-1', { immediate: true })
  expect(current.shutdown).not.toHaveBeenCalled()
})
