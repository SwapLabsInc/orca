import { describe, expect, it, vi } from 'vitest'
import type { PublicKnownRuntimeEnvironment } from '../../../shared/runtime-environments'
import type { RuntimeStatus } from '../../../shared/runtime-types'
import {
  inspectRemoteServerUpdate,
  type RemoteServerUpdateTransport
} from './remote-server-update-coordinator'

const HELP_URL = 'https://example.com/runbooks/orca-update'

const environment: PublicKnownRuntimeEnvironment = {
  id: 'server-1',
  name: 'Build server',
  createdAt: 1,
  updatedAt: 1,
  lastUsedAt: null,
  runtimeId: 'runtime-1',
  endpoints: [{ id: 'ws-1', kind: 'websocket', label: 'WebSocket', endpoint: 'ws://server' }],
  preferredEndpointId: 'ws-1'
}

const manualSupport = {
  installMode: 'unsupported-headless-serve',
  automatic: false,
  reason: 'manual-service-update-required'
}

/** A `status.get` reply as it arrives: JSON, whatever the type says. */
function statusReply(remoteUpdateSupport: unknown): RuntimeStatus {
  return JSON.parse(
    JSON.stringify({
      runtimeId: 'runtime-1',
      rendererGraphEpoch: 0,
      graphStatus: 'ready',
      authoritativeWindowId: null,
      liveTabCount: 0,
      liveLeafCount: 0,
      capabilities: ['updater.remote-control.v1'],
      appVersion: '1.4.0',
      remoteUpdateSupport
    })
  )
}

function transport(reply: RuntimeStatus): RemoteServerUpdateTransport {
  const unexpected = async (): Promise<never> => {
    throw new Error('a manual host must not be asked to update')
  }
  return {
    getRuntimeStatus: vi.fn(async () => reply),
    getUpdaterStatus: vi.fn(unexpected),
    check: vi.fn(unexpected),
    download: vi.fn(unexpected),
    install: vi.fn(unexpected),
    wait: vi.fn(async () => undefined)
  }
}

function inspect(remoteUpdateSupport: unknown): ReturnType<typeof inspectRemoteServerUpdate> {
  return inspectRemoteServerUpdate(
    environment,
    '1.5.0',
    transport(statusReply(remoteUpdateSupport))
  )
}

describe('server update help link across mixed versions', () => {
  it('new client against new host: carries the link into the entry', async () => {
    const entry = await inspect({ ...manualSupport, helpUrl: HELP_URL })

    expect(entry.phase).toBe('manual')
    expect(entry.support).toEqual({ ...manualSupport, helpUrl: HELP_URL })
  })

  it('new client against old host: a support without the field reads as it always did', async () => {
    const entry = await inspect(manualSupport)

    expect(entry.phase).toBe('manual')
    expect(entry.support).toEqual(manualSupport)
    expect(entry.support).not.toHaveProperty('helpUrl')
  })

  it('new client against a host that predates remote updates: no support at all', async () => {
    const entry = await inspect(undefined)

    expect(entry.phase).toBe('manual')
    expect(entry.support).toBeNull()
  })

  it.each([
    ['a number', 42],
    ['null', null],
    ['an object', { href: HELP_URL }],
    ['http', 'http://example.com/runbook'],
    ['a script scheme', 'javascript:alert(1)'],
    ['control characters', 'https://example.com/\nrunbook'],
    ['over-long', `https://example.com/${'a'.repeat(2048)}`]
  ])('ignores a malformed link (%s) without losing the host', async (_label, helpUrl) => {
    const entry = await inspect({ ...manualSupport, helpUrl })

    expect(entry).toMatchObject({ phase: 'manual', currentVersion: '1.4.0', error: null })
    expect(entry.support).toEqual(manualSupport)
    expect(entry.support).not.toHaveProperty('helpUrl')
  })

  it('the link changes nothing else the client decides about the host', async () => {
    const withLink = await inspect({ ...manualSupport, helpUrl: HELP_URL })
    const without = await inspect(manualSupport)

    expect({ ...withLink, support: null }).toEqual({ ...without, support: null })
  })

  it('ignores a link on a host that updates automatically', async () => {
    const automatic = {
      installMode: 'supervised-headless-serve',
      automatic: true,
      reason: 'available'
    }
    const reply = statusReply({ ...automatic, helpUrl: HELP_URL })
    const entry = await inspectRemoteServerUpdate(environment, '1.5.0', transport(reply))

    expect(entry.phase).toBe('available')
    expect(entry.support).toEqual(automatic)
  })
})
