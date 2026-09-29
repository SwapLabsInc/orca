import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FAKE_RUNTIME_DIR } from './daemon-init-test-harness'

const {
  isPackagedMock,
  forkMock,
  isDaemonStaleForCurrentBundleMock,
  killStaleDaemonMock,
  daemonClientMock,
  spawnerInstances,
  trackDaemonReplacedMock,
  importFresh,
  mockConnectedAdoptionClientOnce,
  installDefaultNetConnectStub,
  moduleFactories
} = await vi.hoisted(async () =>
  (await import('./daemon-init-test-harness')).createDaemonInitMocks()
)

const drainMocks = vi.hoisted(() => ({
  isDaemonDrainEnabled: vi.fn(() => true),
  prepareDaemonDrain: vi.fn(),
  abandonDaemonDrain: vi.fn(() => false),
  listDaemonDrainSlots: vi.fn(() => []),
  removeDeadDaemonDrainSlot: vi.fn(async () => false),
  readVerifiedDaemonPid: vi.fn(async () => ({ pid: 4242, launchNonce: 'old' }))
}))

vi.mock('fs', () => moduleFactories.fs())
vi.mock('child_process', async (importOriginal) =>
  moduleFactories.childProcess(await importOriginal<Record<string, unknown>>())
)
vi.mock('net', () => moduleFactories.net())
vi.mock('./daemon-health', () => moduleFactories.daemonHealth())
vi.mock('./daemon-pid-identity', () => ({
  ...moduleFactories.daemonPidIdentity(),
  readVerifiedDaemonPid: drainMocks.readVerifiedDaemonPid
}))
vi.mock('./daemon-tcc-attribution', () => moduleFactories.daemonTccAttribution())
vi.mock('./daemon-bundle-staleness', () => moduleFactories.daemonBundleStaleness())
vi.mock('./daemon-stale-kill', () => moduleFactories.daemonStaleKill())
vi.mock('./daemon-process-start-time', () => moduleFactories.daemonProcessStartTime())
vi.mock('./daemon-pid-file-parse', () => moduleFactories.daemonPidFileParse())
vi.mock('./client', () => moduleFactories.client())
vi.mock('./daemon-lifecycle-event', () => moduleFactories.daemonLifecycleEvent())
vi.mock('./daemon-spawner', () => moduleFactories.daemonSpawner())
vi.mock('./daemon-pty-adapter', () => moduleFactories.daemonPtyAdapter())
vi.mock('../ipc/pty', () => moduleFactories.ipcPty())
vi.mock('./daemon-drain', () => ({
  isDaemonDrainEnabled: drainMocks.isDaemonDrainEnabled,
  prepareDaemonDrain: drainMocks.prepareDaemonDrain,
  abandonDaemonDrain: drainMocks.abandonDaemonDrain,
  listDaemonDrainSlots: drainMocks.listDaemonDrainSlots,
  removeDeadDaemonDrainSlot: drainMocks.removeDeadDaemonDrainSlot
}))

const HAND_OVER = {
  slot: {
    protocolVersion: 36,
    socketPath: '/fake/daemon/drain-v36-0123abcd.sock',
    tokenPath: '/fake/daemon/drain-v36-0123abcd.token',
    pidPath: '/fake/daemon/drain-v36-0123abcd.pid'
  },
  incumbent: { dev: 64769n, ino: 1234n }
}

type Launcher = (socketPath: string, tokenPath: string) => Promise<{ shutdown(): Promise<void> }>

function mockStaleDaemonWithLiveSessions(): void {
  mockConnectedAdoptionClientOnce()
  daemonClientMock.mockImplementationOnce(function MockDaemonClient() {
    return {
      ensureConnected: vi.fn(async () => {}),
      ensureConnectedWithin: vi.fn(async () => {}),
      request: vi.fn(async (method: string) =>
        method === 'listSessions' ? { sessions: [{ sessionId: 'wt-1@@live', isAlive: true }] } : {}
      ),
      disconnect: vi.fn()
    }
  })
  isPackagedMock.mockReturnValue(true)
  isDaemonStaleForCurrentBundleMock.mockReturnValueOnce(true)
}

function readyChild(): unknown {
  return {
    pid: 12345,
    on(event: string, cb: (arg?: unknown) => void) {
      if (event === 'message') {
        queueMicrotask(() => cb({ type: 'ready', pid: 12345, startedAtMs: 1_000_000 }))
      }
      return this
    },
    off() {
      return this
    },
    disconnect: vi.fn(),
    unref: vi.fn()
  }
}

describe('daemon-init: draining a stale daemon with live sessions', () => {
  beforeEach(() => {
    installDefaultNetConnectStub()
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  // The mocked spawner never launches, so the launcher's first call is the one made here.
  async function firstLauncher(): Promise<Launcher> {
    const mod = await importFresh()
    await mod.initDaemonPtyProvider()
    return spawnerInstances.at(-1)!.launcher as Launcher
  }

  it('hands the endpoint over instead of killing or preserving the daemon', async () => {
    const launcher = await firstLauncher()
    mockStaleDaemonWithLiveSessions()
    drainMocks.prepareDaemonDrain.mockResolvedValueOnce(HAND_OVER)
    forkMock.mockImplementationOnce(readyChild)

    await launcher('/fake/socket', '/fake/token')

    expect(drainMocks.prepareDaemonDrain).toHaveBeenCalledWith(
      expect.objectContaining({
        runtimeDir: FAKE_RUNTIME_DIR,
        socketPath: '/fake/socket',
        tokenPath: '/fake/token',
        pid: 4242,
        launchNonce: 'old'
      })
    )
    expect(killStaleDaemonMock).not.toHaveBeenCalled()
    expect(trackDaemonReplacedMock).not.toHaveBeenCalled()
    expect(forkMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.arrayContaining(['--handed-over-endpoint', '64769:1234']),
      expect.anything()
    )
  })

  it('preserves the daemon as before when the hand-over cannot be prepared', async () => {
    const launcher = await firstLauncher()
    mockStaleDaemonWithLiveSessions()
    drainMocks.prepareDaemonDrain.mockResolvedValueOnce(null)

    await launcher('/fake/socket', '/fake/token')

    expect(drainMocks.prepareDaemonDrain).toHaveBeenCalledOnce()
    expect(killStaleDaemonMock).not.toHaveBeenCalled()
    expect(forkMock).not.toHaveBeenCalled()
  })

  it('drains on the first launch only, never on a respawn under a live router', async () => {
    const launcher = await firstLauncher()
    await launcher('/fake/socket', '/fake/token')
    mockStaleDaemonWithLiveSessions()

    await launcher('/fake/socket', '/fake/token')

    expect(drainMocks.prepareDaemonDrain).not.toHaveBeenCalled()
    expect(forkMock).not.toHaveBeenCalled()
  })

  it('takes the hand-over back when the fresh daemon fails to start', async () => {
    const launcher = await firstLauncher()
    mockStaleDaemonWithLiveSessions()
    drainMocks.prepareDaemonDrain.mockResolvedValueOnce(HAND_OVER)
    forkMock.mockImplementationOnce(() => {
      throw new Error('fork failed')
    })

    await expect(launcher('/fake/socket', '/fake/token')).rejects.toThrow()

    expect(drainMocks.abandonDaemonDrain).toHaveBeenCalledWith(
      HAND_OVER,
      '/fake/socket',
      expect.stringMatching(/daemon-v\d+\.pid$/)
    )
  })
})
