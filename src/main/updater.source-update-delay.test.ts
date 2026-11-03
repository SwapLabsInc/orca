import type { getReleaseDownloadUrl } from './updater/releases/updater-release-readiness'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { loadUpdaterModule, warmUpdaterModule } from './updater/testing/updater-test-module-loader'
import { updaterMainWindow } from './updater/testing/updater-test-main-window'
import {
  FORK_RELEASE_SOURCES_LITERAL,
  setReleaseSourcesLiteralForTest
} from '../shared/release-sources.fixture'

const {
  appMock,
  autoUpdaterMock,
  fetchNewerReleaseTagsMock,
  fetchLatestStableReleaseTagMock,
  moduleFactories,
  resetUpdaterMocks
} = await vi.hoisted(async () =>
  (await import('./updater/testing/updater-test-harness')).createUpdaterMocks()
)

vi.mock('electron', () => moduleFactories.electron())
vi.mock('electron-updater', () => moduleFactories.electronUpdater())
vi.mock('./updater/electron-updater-loader', () => moduleFactories.electronUpdaterLoader())
vi.mock('./ipc/pty/kill-all', () => moduleFactories.ptyKillAll())
vi.mock('./updater/linux-package/linux-update-package-type', () =>
  moduleFactories.linuxUpdatePackageType()
)
vi.mock('./updater/updater-lifecycle-diagnostics', () =>
  moduleFactories.updaterLifecycleDiagnostics()
)
vi.mock('./updater/releases/updater-changelog', () => moduleFactories.updaterChangelog())
vi.mock('./updater/nudges/nudge-campaign', () => moduleFactories.updaterNudge())
vi.mock('./updater/update-install-exit-watchdog', () => moduleFactories.updateInstallExitWatchdog())
vi.mock('./updater/releases/updater-prerelease-feed', () => moduleFactories.updaterPrereleaseFeed())
vi.mock('./updater/releases/updater-release-readiness', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getReleaseDownloadUrl: (
    await vi.importMock<{
      getReleaseDownloadUrl: typeof getReleaseDownloadUrl
    }>('./updater/releases/updater-prerelease-feed')
  ).getReleaseDownloadUrl
}))
vi.mock('./local-builds/local-build-switch', () => moduleFactories.localBuildSwitch())
vi.mock('./local-builds/local-build-feed-server', () => moduleFactories.localBuildFeedServer())

warmUpdaterModule()

const DAY_MS = 24 * 60 * 60 * 1000
const RELEASED_AT = Date.parse('2026-11-01T00:00:00Z')
const NOW = RELEASED_AT + 2 * DAY_MS
const FORK_VERSION = '1.4.197-swaplabs.202610010000'
const HELD_VERSION = '1.4.197-swaplabs.202611010000'

describe('updater update delay on a fork build', () => {
  beforeEach(() => {
    resetUpdaterMocks()
    setReleaseSourcesLiteralForTest(FORK_RELEASE_SOURCES_LITERAL)
    // Fake only Date so a fixed "last checked" time suppresses the startup check while vi.waitFor keeps real timers.
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] })
    appMock.getVersion.mockReturnValue(FORK_VERSION)
  })

  afterEach(() => {
    vi.useRealTimers()
    setReleaseSourcesLiteralForTest(null)
  })

  it('holds a release of its own source and reports it without the stable fallback', async () => {
    fetchNewerReleaseTagsMock.mockResolvedValue({
      tags: [],
      state: 'no-newer',
      releaseDelay: {
        heldRelease: {
          tag: 'swaplabs-v1.4.197+202611010000',
          version: HELD_VERSION,
          releasedAt: RELEASED_AT
        },
        isTagOldEnough: () => false
      }
    })
    const sendMock = vi.fn()
    const { setupAutoUpdater, checkForUpdatesFromMenu } = await loadUpdaterModule()
    setupAutoUpdater(updaterMainWindow(sendMock), {
      getLastUpdateCheckAt: () => NOW,
      getUpdateDelayDays: () => 7
    })

    checkForUpdatesFromMenu()

    await vi.waitFor(() => {
      expect(sendMock).toHaveBeenLastCalledWith(
        'updater:status',
        expect.objectContaining({
          state: 'not-available',
          userInitiated: true,
          delayedUpdate: {
            version: HELD_VERSION,
            releasedAt: new Date(RELEASED_AT).toISOString(),
            availableAt: new Date(RELEASED_AT + 7 * DAY_MS).toISOString(),
            delayDays: 7
          }
        })
      )
    })
    expect(fetchNewerReleaseTagsMock).toHaveBeenCalledWith(
      FORK_VERSION,
      2,
      expect.objectContaining({
        minReleaseAgeMs: 7 * DAY_MS,
        source: expect.objectContaining({ id: 'swaplabs' })
      })
    )
    expect(fetchLatestStableReleaseTagMock).not.toHaveBeenCalled()
    expect(autoUpdaterMock.checkForUpdates).not.toHaveBeenCalled()
  })
})
