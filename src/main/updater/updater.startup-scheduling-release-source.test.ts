import type { getReleaseDownloadUrl } from './releases/updater-release-readiness'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { loadUpdaterModule, warmUpdaterModule } from './testing/updater-test-module-loader'
import { createUpdaterMainWindowFake } from '../updater-main-window.fixture'
import {
  FORK_RELEASE_SOURCES_LITERAL,
  setReleaseSourcesLiteralForTest
} from '../../shared/release-sources.fixture'
import { updaterMainWindow } from './testing/updater-test-main-window'

const { appMock, autoUpdaterMock, fetchNewerReleaseTagsMock, moduleFactories, resetUpdaterMocks } =
  await vi.hoisted(async () =>
    (await import('./testing/updater-test-harness')).createUpdaterMocks()
  )

const FORK_VERSION = '1.4.197-swaplabs.202609241530'
const FORK_TAG = 'swaplabs-v1.4.197+resume.2'
const FORK_FEED_URL = `https://github.com/SwapLabsInc/orca/releases/download/${FORK_TAG}`

/** Runs a test as a fork build: two configured sources and a source-stamped running version. */
function asForkBuild(): void {
  setReleaseSourcesLiteralForTest(FORK_RELEASE_SOURCES_LITERAL)
  appMock.getVersion.mockReturnValue(FORK_VERSION)
}

vi.mock('electron', () => moduleFactories.electron())
vi.mock('electron-updater', () => moduleFactories.electronUpdater())
vi.mock('./electron-updater-loader', () => moduleFactories.electronUpdaterLoader())
vi.mock('../ipc/pty/kill-all', () => moduleFactories.ptyKillAll())
vi.mock('./linux-package/linux-update-package-type', () => moduleFactories.linuxUpdatePackageType())
vi.mock('./updater-lifecycle-diagnostics', () => moduleFactories.updaterLifecycleDiagnostics())
vi.mock('./releases/updater-changelog', () => moduleFactories.updaterChangelog())
vi.mock('./nudges/nudge-campaign', () => moduleFactories.updaterNudge())
vi.mock('./update-install-exit-watchdog', () => moduleFactories.updateInstallExitWatchdog())
vi.mock('./releases/updater-prerelease-feed', () => moduleFactories.updaterPrereleaseFeed())
vi.mock('./releases/updater-release-readiness', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getReleaseDownloadUrl: (
    await vi.importMock<{
      getReleaseDownloadUrl: typeof getReleaseDownloadUrl
    }>('./releases/updater-prerelease-feed')
  ).getReleaseDownloadUrl
}))
vi.mock('../local-builds/local-build-switch', () => moduleFactories.localBuildSwitch())
vi.mock('../local-builds/local-build-feed-server', () => moduleFactories.localBuildFeedServer())

warmUpdaterModule()

describe('updater startup check on a fork build', () => {
  beforeEach(() => {
    resetUpdaterMocks()
    vi.useFakeTimers()
  })

  afterEach(() => {
    setReleaseSourcesLiteralForTest(null)
  })

  // Why: a fork version is semver-below upstream's next stable, so upstream's feed would replace it.
  it('pins the running source feed for a startup check on a source build', async () => {
    asForkBuild()
    fetchNewerReleaseTagsMock.mockResolvedValue([FORK_TAG])
    const mainWindow = updaterMainWindow(vi.fn())

    const { setupAutoUpdater } = await loadUpdaterModule()
    setupAutoUpdater(mainWindow, {
      getLastUpdateCheckAt: () => Date.now() - 25 * 60 * 60 * 1000
    })

    expect(autoUpdaterMock.setFeedURL).toHaveBeenNthCalledWith(1, {
      provider: 'generic',
      url: 'https://github.com/SwapLabsInc/orca/releases/latest/download'
    })
    await vi.waitFor(() => {
      expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1)
    })
    expect(fetchNewerReleaseTagsMock).toHaveBeenCalledWith(FORK_VERSION, 2, {
      includePrerelease: true,
      source: expect.objectContaining({ id: 'swaplabs', repo: 'SwapLabsInc/orca' })
    })
    expect(autoUpdaterMock.setFeedURL).toHaveBeenLastCalledWith({
      provider: 'generic',
      url: FORK_FEED_URL
    })
  })

  // Why: a prerelease-only source has no /releases/latest fallback, so the feed's no-newer is final.
  it('settles a source build with nothing newer as not-available without launching a check', async () => {
    asForkBuild()
    fetchNewerReleaseTagsMock.mockResolvedValue([])
    const { mainWindow, send } = createUpdaterMainWindowFake()
    const setLastUpdateCheckAt = vi.fn()

    const { setupAutoUpdater } = await loadUpdaterModule()
    setupAutoUpdater(mainWindow, {
      getLastUpdateCheckAt: () => Date.now() - 25 * 60 * 60 * 1000,
      setLastUpdateCheckAt
    })

    await vi.waitFor(() => {
      expect(send).toHaveBeenCalledWith('updater:status', { state: 'not-available' })
    })
    expect(autoUpdaterMock.checkForUpdates).not.toHaveBeenCalled()
    expect(setLastUpdateCheckAt).toHaveBeenCalledTimes(1)
  })
})
