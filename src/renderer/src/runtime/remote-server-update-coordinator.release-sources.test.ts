import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PublicKnownRuntimeEnvironment } from '../../../shared/remote-runtime/host-catalog/runtime-environments'
import type { RuntimeStatus } from '../../../shared/runtime-types'
import type {
  RemoteServerUpdateInstallResult,
  RemoteServerUpdaterSnapshot
} from '../../../shared/remote-server-update'
import {
  inspectRemoteServerUpdate,
  type RemoteServerUpdateTransport
} from './remote-server-update-coordinator'
import {
  FORK_RELEASE_SOURCES_LITERAL,
  setReleaseSourcesLiteralForTest
} from '../../../shared/release-sources.fixture'

const environment: PublicKnownRuntimeEnvironment = {
  id: 'server-1',
  name: 'Build server',
  createdAt: 1,
  updatedAt: 1,
  lastUsedAt: null,
  runtimeId: 'runtime-old',
  endpoints: [{ id: 'ws-1', kind: 'websocket', label: 'WebSocket', endpoint: 'ws://server' }],
  preferredEndpointId: 'ws-1'
}

function status(version: string, runtimeId = 'runtime-old', automatic = true): RuntimeStatus {
  return {
    runtimeId,
    rendererGraphEpoch: 0,
    graphStatus: 'ready',
    authoritativeWindowId: null,
    liveTabCount: 2,
    liveLeafCount: 1,
    capabilities: automatic ? ['updater.remote-control.v1'] : [],
    appVersion: version,
    remoteUpdateSupport: automatic
      ? { installMode: 'supervised-headless-serve', automatic: true, reason: 'available' }
      : {
          installMode: 'unsupported-headless-serve',
          automatic: false,
          reason: 'manual-service-update-required'
        }
  }
}

const availableSnapshot: RemoteServerUpdaterSnapshot = {
  appVersion: '1.4.0',
  runtimeId: 'runtime-old',
  support: { installMode: 'supervised-headless-serve', automatic: true, reason: 'available' },
  status: { state: 'available', version: '1.5.0', changelog: null }
}

function transport(
  overrides: Partial<RemoteServerUpdateTransport> = {}
): RemoteServerUpdateTransport {
  let clock = 0
  return {
    getRuntimeStatus: vi.fn(async () => status('1.4.0')),
    getUpdaterStatus: vi.fn(async () => availableSnapshot),
    check: vi.fn(async () => availableSnapshot),
    download: vi.fn(async () => availableSnapshot),
    install: vi.fn(async (): Promise<RemoteServerUpdateInstallResult> => ({
      accepted: true,
      fromVersion: '1.4.0',
      targetVersion: '1.5.0',
      runtimeId: 'runtime-old'
    })),
    wait: vi.fn(async (milliseconds) => {
      clock += milliseconds
    }),
    now: () => clock,
    ...overrides
  }
}

describe('remote server update inventory across release sources', () => {
  /** A client built with two sources, as a fork build is; the default single-source client is the static import above. */
  async function loadForkCoordinator() {
    setReleaseSourcesLiteralForTest(FORK_RELEASE_SOURCES_LITERAL)
    vi.resetModules()
    return (await import('./remote-server-update-coordinator')).inspectRemoteServerUpdate
  }

  afterEach(() => {
    setReleaseSourcesLiteralForTest(null)
    vi.resetModules()
  })

  it('keeps the outdated verdict for a same-source server that names its source', async () => {
    const inspect = await loadForkCoordinator()

    await expect(
      inspect(
        environment,
        '1.5.0',
        transport({
          getRuntimeStatus: async () => ({ ...status('1.4.0'), releaseSource: 'upstream' })
        })
      )
    ).resolves.toMatchObject({
      phase: 'available',
      currentVersion: '1.4.0',
      targetVersion: '1.5.0'
    })
  })

  it('places a server that omits its source by its version, so an older upstream host still compares', async () => {
    const inspect = await loadForkCoordinator()

    await expect(inspect(environment, '1.5.0', transport())).resolves.toMatchObject({
      phase: 'available',
      currentVersion: '1.4.0'
    })
    // A fork client against an upstream server: different sources, never "outdated".
    await expect(
      inspect(environment, '1.4.197-swaplabs.202609241530', transport())
    ).resolves.toMatchObject({ phase: 'manual', currentVersion: '1.4.0', targetVersion: null })
  })

  // Why: `1.4.197-swaplabs.x` is semver-below `1.4.197`, so a plain compare would
  // tell an upstream client to "update" a fork server to upstream.
  it('never marks a server from a different release source outdated', async () => {
    const inspect = await loadForkCoordinator()
    const forkServer = transport({
      getRuntimeStatus: async () => ({
        ...status('1.4.197-swaplabs.202609241530'),
        releaseSource: 'swaplabs'
      })
    })

    await expect(inspect(environment, '1.4.197', forkServer)).resolves.toMatchObject({
      phase: 'manual',
      currentVersion: '1.4.197-swaplabs.202609241530',
      targetVersion: null
    })
    // The single-source client cannot classify the version, but the host's own word is enough.
    await expect(
      inspectRemoteServerUpdate(environment, '1.4.197', forkServer)
    ).resolves.toMatchObject({ phase: 'manual', targetVersion: null })
    await expect(
      inspect(environment, '1.4.197-swaplabs.202609241600', forkServer)
    ).resolves.toMatchObject({ phase: 'available', targetVersion: '1.4.197-swaplabs.202609241600' })
  })

  // Why: a fork host that predates releaseSource carries an identifier the single-source client has
  // no source for; placing it as upstream would offer to replace the fork with upstream.
  it('keeps a source-less host with an unknown identifier manual on a single-source client', async () => {
    const oldForkServer = transport({
      getRuntimeStatus: async () => status('1.4.197-swaplabs.202609241530')
    })

    await expect(
      inspectRemoteServerUpdate(environment, '1.4.197', oldForkServer)
    ).resolves.toMatchObject({ phase: 'manual', targetVersion: null })
  })
})
