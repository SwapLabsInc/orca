import { mkdtempSync, rmSync } from 'node:fs'
import { createConnection, createServer, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { handedOverEndpointArg } from '../daemon-endpoint-handover'
import {
  getDaemonSocketBindPath,
  publishDaemonEndpoint,
  readDaemonSocketIdentity
} from '../daemon-endpoint-ownership'
import { probeSocketConnect } from '../daemon-endpoint-probe'
import { parseArgs } from '../../../launch/daemon-command-arguments'

const unixIt = it.skipIf(process.platform === 'win32')

type Listener = { server: Server; connections: () => number }

async function listen(socketPath: string): Promise<Listener> {
  let connectionCount = 0
  const server = createServer((socket) => {
    connectionCount += 1
    socket.end()
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(socketPath, resolve)
  })
  return { server, connections: () => connectionCount }
}

async function close(server: Server): Promise<void> {
  if (!server.listening) {
    return
  }
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()))
  })
}

async function expectReachable(socketPath: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const socket = createConnection(socketPath)
    socket.once('connect', () => {
      socket.end()
      resolve()
    })
    socket.once('error', reject)
  })
  await new Promise<void>((resolve) => setImmediate(resolve))
}

describe('handedOverEndpointArg', () => {
  it('reads the endpoint a draining launch hands over, and refuses one it cannot read', () => {
    const args = ['--socket', '/tmp/test.sock', '--token', '/tmp/test.token']
    expect(handedOverEndpointArg(args)).not.toHaveProperty('handedOverEndpoint')
    expect(handedOverEndpointArg([...args, '--handed-over-endpoint', '64769:1234'])).toHaveProperty(
      'handedOverEndpoint',
      { dev: 64769n, ino: 1234n }
    )
    for (const value of ['', '64769', '64769:', 'a:b', '-1:2', '1:2:3']) {
      expect(() =>
        handedOverEndpointArg([...args, '--handed-over-endpoint', value, '--x'])
      ).toThrow()
    }
  })

  it('leaves the rest of the daemon arguments to upstream parseArgs unchanged', () => {
    const args = ['--socket', '/tmp/test.sock', '--token', '/tmp/test.token']
    expect(parseArgs([...args, '--handed-over-endpoint', '64769:1234'])).toEqual(parseArgs(args))
  })
})

describe('publishDaemonEndpoint with a handed-over incumbent', () => {
  unixIt('leaves a live incumbent in place when it is not the one handed over', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'orca-p-'))
    const canonicalPath = join(directory, 'd')
    const incumbentPath = getDaemonSocketBindPath(canonicalPath)
    const newcomerPath = getDaemonSocketBindPath(canonicalPath)
    const incumbent = await listen(incumbentPath)
    const newcomer = await listen(newcomerPath)
    try {
      const published = await publishDaemonEndpoint(
        incumbentPath,
        canonicalPath,
        probeSocketConnect
      )
      expect(published.status).toBe('published')
      const other = readDaemonSocketIdentity(canonicalPath)!

      const outcome = await publishDaemonEndpoint(newcomerPath, canonicalPath, probeSocketConnect, {
        dev: other.dev,
        ino: other.ino + 1n
      })

      expect(outcome).toEqual({ status: 'occupied' })
      await expectReachable(canonicalPath)
      expect(newcomer.connections()).toBe(0)
    } finally {
      await Promise.all([close(incumbent.server), close(newcomer.server)])
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
