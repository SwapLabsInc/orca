import './mock-descendant-sweep'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DaemonClient } from './client'
import {
  abandonDaemonDrain,
  isDaemonDrainEnabled,
  listDaemonDrainSlots,
  prepareDaemonDrain,
  removeDeadDaemonDrainSlot,
  type DaemonDrainHandOver
} from './daemon-drain'
import { DAEMON_ENDPOINT_LOST_MESSAGE, readDaemonSocketIdentity } from './daemon-endpoint-ownership'
import { waitForEndpointUnreachable } from './daemon-endpoint-reachability-test-harness'
import { createLegacyDaemonAdapters } from './daemon-legacy-adapters'
import { DaemonServer } from './daemon-server'
import {
  getDaemonPidPath,
  getDaemonSocketPath,
  getDaemonTokenPath,
  publishDaemonPidFile,
  serializeDaemonPidFile
} from './daemon-spawner'
import type { SubprocessHandle } from './session-subprocess-handle'
import { PROTOCOL_VERSION } from './types'

const unixIt = it.skipIf(process.platform === 'win32')

function createMockSubprocess(): SubprocessHandle & {
  exit(code: number): void
} {
  let onExit: ((code: number) => void) | null = null
  return {
    pid: 9345,
    getForegroundProcess: () => null,
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    terminateOwnedTree: () => 'unavailable' as const,
    forceKill: vi.fn(),
    signal: vi.fn(),
    onData: vi.fn(),
    onExit(callback) {
      onExit = callback
    },
    dispose: vi.fn(),
    exit(code) {
      onExit?.(code)
    }
  }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error('Timed out waiting for the drained daemon')
    }
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

// A clock that never fires, so neither daemon retires for want of an adopting client.
const idleClock = {
  setTimeout: () => ({}),
  clearTimeout: () => {},
  now: () => 0
}

describe('isDaemonDrainEnabled', () => {
  it('is on only for 1, and never on Windows', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const env = (value?: string): NodeJS.ProcessEnv =>
      value === undefined ? {} : { ORCA_DAEMON_DRAIN_STALE_BUNDLE: value }
    expect(isDaemonDrainEnabled(env('1'), 'linux')).toBe(true)
    expect(isDaemonDrainEnabled(env(' 1 '), 'darwin')).toBe(true)
    expect(isDaemonDrainEnabled(env('1'), 'win32')).toBe(false)
    expect(isDaemonDrainEnabled(env(), 'linux')).toBe(false)
    expect(isDaemonDrainEnabled(env('0'), 'linux')).toBe(false)
    expect(warn).not.toHaveBeenCalled()
    expect(isDaemonDrainEnabled(env('true'), 'linux')).toBe(false)
    expect(warn).toHaveBeenCalledOnce()
    warn.mockRestore()
  })
})

describe('draining a stale daemon', () => {
  let dir: string
  let socketPath: string
  let tokenPath: string
  let pidPath: string
  let servers: DaemonServer[]
  let clients: DaemonClient[]

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'daemon-drain-'))
    socketPath = getDaemonSocketPath(dir)
    tokenPath = getDaemonTokenPath(dir)
    pidPath = getDaemonPidPath(dir)
    servers = []
    clients = []
  })

  afterEach(async () => {
    for (const client of clients) {
      client.disconnect()
    }
    await Promise.all(servers.map((server) => server.shutdown().catch(() => {})))
    rmSync(dir, { recursive: true, force: true })
  })

  async function startDaemon(
    launchNonce: string,
    subprocess: SubprocessHandle,
    extra: {
      handedOverEndpoint?: DaemonDrainHandOver['incumbent']
      onIdleShutdown?: () => void
    } = {}
  ): Promise<DaemonServer> {
    const server = new DaemonServer({
      socketPath,
      tokenPath,
      pidPath,
      launchNonce,
      publishEndpointOwnership: () =>
        publishDaemonPidFile(pidPath, {
          pid: process.pid,
          startedAtMs: null,
          launchNonce
        }),
      initialAdoptionTestConfig: { timeoutMs: 60_000, clock: idleClock },
      spawnSubprocess: () => subprocess,
      ...extra
    })
    await server.start()
    servers.push(server)
    return server
  }

  async function connect(path: string, token: string): Promise<DaemonClient> {
    const client = new DaemonClient({ socketPath: path, tokenPath: token })
    clients.push(client)
    await client.ensureConnected()
    return client
  }

  function drain(launchNonce: string | null = 'old'): Promise<DaemonDrainHandOver | null> {
    return prepareDaemonDrain({
      runtimeDir: dir,
      socketPath,
      tokenPath,
      pidPath,
      protocolVersion: PROTOCOL_VERSION,
      pid: process.pid,
      launchNonce
    })
  }

  unixIt(
    'keeps the old daemon’s sessions on it while a fresh daemon takes the endpoint',
    async () => {
      const oldSession = createMockSubprocess()
      const oldRetired = vi.fn()
      await startDaemon('old', oldSession, { onIdleShutdown: oldRetired })
      const before = await connect(socketPath, tokenPath)
      await before.request('createOrAttach', {
        sessionId: 'kept',
        cols: 80,
        rows: 24
      })
      before.disconnect() // the app restarting onto a newer bundle

      const handOver = await drain()
      expect(handOver).not.toBeNull()
      const { slot, incumbent } = handOver!
      expect(existsSync(pidPath)).toBe(false)
      expect(readFileSync(slot.pidPath, 'utf8')).toContain('"launchNonce":"old"')
      expect(listDaemonDrainSlots(dir)).toEqual([slot])

      await startDaemon('new', createMockSubprocess(), {
        handedOverEndpoint: incumbent
      })
      expect(readDaemonSocketIdentity(socketPath)).not.toEqual(incumbent)
      expect(readDaemonSocketIdentity(slot.socketPath)).toEqual(incumbent)
      expect(readFileSync(pidPath, 'utf8')).toContain('"launchNonce":"new"')

      // The next app start finds the drained daemon beside the current one.
      const found = await createLegacyDaemonAdapters(dir, join(dir, 'history'))
      expect(found.map((adapter) => [adapter.draining, adapter.protocolVersion])).toEqual([
        [true, PROTOCOL_VERSION]
      ])

      // New terminals start on the fresh daemon.
      const fresh = await connect(socketPath, tokenPath)
      await expect(
        fresh.request('createOrAttach', {
          sessionId: 'fresh',
          cols: 80,
          rows: 24
        })
      ).resolves.toBeTruthy()

      // The old daemon still holds its session, attachable through the drain name only.
      const drained = await connect(slot.socketPath, slot.tokenPath)
      await expect(
        drained.request('createOrAttach', {
          sessionId: 'kept',
          cols: 80,
          rows: 24,
          attachOnly: true
        })
      ).resolves.toBeTruthy()
      await expect(
        drained.request('createOrAttach', {
          sessionId: 'other',
          cols: 80,
          rows: 24
        })
      ).rejects.toThrow(DAEMON_ENDPOINT_LOST_MESSAGE)

      // Its last session ending retires it, and its departure leaves the fresh daemon's files.
      expect(oldRetired).not.toHaveBeenCalled()
      oldSession.exit(0)
      await waitFor(() => oldRetired.mock.calls.length === 1)
      expect(await waitForEndpointUnreachable(slot.socketPath)).toBe(true)
      expect(readFileSync(pidPath, 'utf8')).toContain('"launchNonce":"new"')
      await expect(
        fresh.request('createOrAttach', {
          sessionId: 'fresh-2',
          cols: 80,
          rows: 24
        })
      ).resolves.toBeTruthy()
    }
  )

  unixIt('leaves everything as it was when the record names another incarnation', async () => {
    await startDaemon('old', createMockSubprocess())
    expect(await drain('someone-else')).toBeNull()
    expect(readFileSync(pidPath, 'utf8')).toContain('"launchNonce":"old"')
    expect(listDaemonDrainSlots(dir)).toEqual([])
  })

  unixIt('leaves everything as it was when the daemon does not answer its token', async () => {
    await startDaemon('old', createMockSubprocess())
    const token = readFileSync(tokenPath, 'utf8')
    writeFileSync(tokenPath, 'not-the-token')
    expect(await drain()).toBeNull()
    writeFileSync(tokenPath, token)
    expect(readFileSync(pidPath, 'utf8')).toContain('"launchNonce":"old"')
    expect(listDaemonDrainSlots(dir)).toEqual([])
  })

  unixIt('takes back a hand-over only while the incumbent still holds the endpoint', async () => {
    await startDaemon('old', createMockSubprocess())
    const handOver = (await drain())!
    expect(abandonDaemonDrain(handOver, socketPath, pidPath)).toBe(true)
    expect(readFileSync(pidPath, 'utf8')).toContain('"launchNonce":"old"')
    expect(listDaemonDrainSlots(dir)).toEqual([])

    const again = (await drain())!
    await startDaemon('new', createMockSubprocess(), {
      handedOverEndpoint: again.incumbent
    })
    expect(abandonDaemonDrain(again, socketPath, pidPath)).toBe(false)
    expect(listDaemonDrainSlots(dir)).toEqual([again.slot])
  })

  it('has nothing to drain without an endpoint', async () => {
    expect(await drain()).toBeNull()
  })
})

describe('removeDeadDaemonDrainSlot', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'daemon-drain-slot-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  function slotWith(record: string | null): ReturnType<typeof listDaemonDrainSlots>[number] {
    const base = join(dir, `drain-v${PROTOCOL_VERSION}-0123abcd`)
    writeFileSync(`${base}.sock`, '') // a regular file: nothing can be serving it
    writeFileSync(`${base}.token`, 'token')
    if (record !== null) {
      writeFileSync(`${base}.pid`, record)
    }
    return listDaemonDrainSlots(dir)[0]
  }

  unixIt('removes a slot whose daemon is proven gone', async () => {
    const slot = slotWith(serializeDaemonPidFile({ pid: 2 ** 22 + 1, startedAtMs: null }))
    expect(await removeDeadDaemonDrainSlot(slot)).toBe(true)
    expect(listDaemonDrainSlots(dir)).toEqual([])
    expect(existsSync(slot.tokenPath)).toBe(false)
  })

  unixIt('keeps a slot whose recorded process is alive or whose record is unreadable', async () => {
    const alive = slotWith(serializeDaemonPidFile({ pid: process.pid, startedAtMs: null }))
    expect(await removeDeadDaemonDrainSlot(alive)).toBe(false)
    const garbled = slotWith('{not json')
    expect(await removeDeadDaemonDrainSlot(garbled)).toBe(false)
    expect(listDaemonDrainSlots(dir)).toHaveLength(1)
  })
})
