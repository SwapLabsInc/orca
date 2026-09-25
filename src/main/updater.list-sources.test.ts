import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { loadUpdaterModule, warmUpdaterModule } from './updater-test-module-loader'
import { createUpdaterMainWindowFake } from './updater-main-window.fixture'
import {
  FORK_RELEASE_SOURCES_LITERAL,
  setReleaseSourcesLiteralForTest
} from '../shared/release-sources.fixture'
import type { ReleaseBuild } from '../shared/release-channel'
import type * as ReleaseBuildsModule from './updater-release-builds'

const { appMock, moduleFactories, resetUpdaterMocks } = await vi.hoisted(async () =>
  (await import('./updater-test-harness')).createUpdaterMocks()
)
const { listReleaseBuildsMock } = vi.hoisted(() => ({ listReleaseBuildsMock: vi.fn() }))

vi.mock('electron', () => moduleFactories.electron())
vi.mock('electron-updater', () => moduleFactories.electronUpdater())
vi.mock('./electron-updater-loader', () => moduleFactories.electronUpdaterLoader())
vi.mock('@electron-toolkit/utils', () => moduleFactories.electronToolkitUtils())
vi.mock('./ipc/pty', () => moduleFactories.ipcPty())
vi.mock('./linux-update-package-type', () => moduleFactories.linuxUpdatePackageType())
vi.mock('./updater-lifecycle-diagnostics', () => moduleFactories.updaterLifecycleDiagnostics())
vi.mock('./updater-changelog', () => moduleFactories.updaterChangelog())
vi.mock('./updater-nudge', () => moduleFactories.updaterNudge())
vi.mock('./update-install-exit-watchdog', () => moduleFactories.updateInstallExitWatchdog())
vi.mock('./updater-prerelease-feed', () => moduleFactories.updaterPrereleaseFeed())
vi.mock('./local-builds/local-build-switch', () => moduleFactories.localBuildSwitch())
vi.mock('./local-builds/local-build-feed-server', () => moduleFactories.localBuildFeedServer())
// Why only the lister: the GitHub REST client has its own suite; this one is about what main
// tells the Updates section per source.
vi.mock('./updater-release-builds', async (importOriginal) => ({
  ...(await importOriginal<typeof ReleaseBuildsModule>()),
  listReleaseBuilds: (...args: unknown[]) => listReleaseBuildsMock(...args)
}))

warmUpdaterModule()

const FORK_VERSION = '1.4.197-swaplabs.202609251710'

function build(version: string, tag: string, repo: string): ReleaseBuild {
  return {
    tag,
    version,
    channel: 'stable',
    name: null,
    publishedAt: null,
    releaseUrl: `https://github.com/${repo}/releases/tag/${tag}`,
    installerUrl: `https://github.com/${repo}/releases/download/${tag}/orca-linux.AppImage`
  }
}

const UPSTREAM_BUILDS = [build('1.4.198', 'v1.4.198', 'stablyai/orca')]
const FORK_BUILDS = [build(FORK_VERSION, 'swaplabs-v1.4.197+202609251710', 'SwapLabsInc/orca')]

function listBuildsBySource(): void {
  listReleaseBuildsMock.mockImplementation(
    async (_channel: unknown, _platform: unknown, source: { id: string }) =>
      source.id === 'swaplabs' ? FORK_BUILDS : UPSTREAM_BUILDS
  )
}

describe('updater listReleaseSources', () => {
  beforeEach(() => {
    resetUpdaterMocks()
    listReleaseBuildsMock.mockReset()
    moduleFactories.linuxUpdatePackageType().isExternallyManagedLinuxInstall.mockReturnValue(false)
    setReleaseSourcesLiteralForTest(FORK_RELEASE_SOURCES_LITERAL)
    appMock.getVersion.mockReturnValue(FORK_VERSION)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    setReleaseSourcesLiteralForTest(null)
  })

  function usePlatform(platform: NodeJS.Platform): void {
    vi.spyOn(process, 'platform', 'get').mockReturnValue(platform)
  }

  it('lists every source with its newest stable build and marks the running one', async () => {
    usePlatform('linux')
    listBuildsBySource()
    const { setupAutoUpdater, listReleaseSources } = await loadUpdaterModule()
    setupAutoUpdater(createUpdaterMainWindowFake().mainWindow)

    await expect(listReleaseSources()).resolves.toEqual([
      {
        id: 'upstream',
        label: 'Orca upstream',
        running: false,
        install: 'in-app',
        latest: UPSTREAM_BUILDS[0],
        error: null
      },
      {
        id: 'swaplabs',
        label: 'SwapLabs',
        running: true,
        install: 'in-app',
        latest: FORK_BUILDS[0],
        error: null
      }
    ])
    expect(listReleaseBuildsMock).toHaveBeenCalledTimes(2)
    expect(listReleaseBuildsMock).toHaveBeenCalledWith(
      'stable',
      'linux',
      expect.objectContaining({ id: 'upstream' }),
      process.arch
    )
  })

  // Why: the button that names the action must not promise an in-app install that
  // `checkForPinnedBuild` would refuse with a signature error a moment later.
  it('reports a manual installer for a cross-source jump on macOS', async () => {
    usePlatform('darwin')
    listBuildsBySource()
    const { setupAutoUpdater, listReleaseSources } = await loadUpdaterModule()
    setupAutoUpdater(createUpdaterMainWindowFake().mainWindow)

    const rows = await listReleaseSources()
    expect(rows.map((row) => [row.id, row.install])).toEqual([
      ['upstream', 'manual-installer'],
      ['swaplabs', 'in-app']
    ])
  })

  it('reports every source as externally managed for a package-manager install', async () => {
    usePlatform('linux')
    listBuildsBySource()
    moduleFactories.linuxUpdatePackageType().isExternallyManagedLinuxInstall.mockReturnValue(true)
    const { setupAutoUpdater, listReleaseSources } = await loadUpdaterModule()
    setupAutoUpdater(createUpdaterMainWindowFake().mainWindow)

    const rows = await listReleaseSources()
    expect(rows.map((row) => row.install)).toEqual(['externally-managed', 'externally-managed'])
  })

  // Why: one unreachable repository must not hide the other; the failure travels as data.
  it('returns a list failure per source without rejecting the whole read', async () => {
    usePlatform('linux')
    listReleaseBuildsMock.mockImplementation(
      async (_channel: unknown, _platform: unknown, source: { id: string }) => {
        if (source.id === 'upstream') {
          throw new Error('GitHub rate limit reached. Try again in about a minute.')
        }
        return FORK_BUILDS
      }
    )
    const { setupAutoUpdater, listReleaseSources } = await loadUpdaterModule()
    setupAutoUpdater(createUpdaterMainWindowFake().mainWindow)

    const rows = await listReleaseSources()
    expect(rows[0]).toMatchObject({
      id: 'upstream',
      latest: null,
      error: 'GitHub rate limit reached. Try again in about a minute.'
    })
    expect(rows[1]).toMatchObject({ id: 'swaplabs', latest: FORK_BUILDS[0], error: null })
  })

  it('serves repeats from the shared build cache unless forced', async () => {
    usePlatform('linux')
    listBuildsBySource()
    const { setupAutoUpdater, listReleaseSources, listAvailableReleaseBuilds } =
      await loadUpdaterModule()
    setupAutoUpdater(createUpdaterMainWindowFake().mainWindow)

    await listReleaseSources()
    await listReleaseSources()
    // The dev picker's own list of the same source and channel is the same cache entry.
    await listAvailableReleaseBuilds('stable', { source: 'swaplabs' })
    expect(listReleaseBuildsMock).toHaveBeenCalledTimes(2)

    await listReleaseSources({ force: true })
    expect(listReleaseBuildsMock).toHaveBeenCalledTimes(4)
  })
})
