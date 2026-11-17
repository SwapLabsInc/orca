import type { getReleaseDownloadUrl } from './releases/updater-release-readiness'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { loadUpdaterModule, warmUpdaterModule } from './testing/updater-test-module-loader'
import { updaterMainWindow } from './testing/updater-test-main-window'

const {
  appMock,
  autoUpdaterMock,
  moduleFactories,
  resetUpdaterMocks,
  verifyReleaseTagManifestMock
} = await vi.hoisted(async () =>
  (await import('./testing/updater-test-harness')).createUpdaterMocks()
)

vi.mock('electron', () => moduleFactories.electron())
vi.mock('electron-updater', () => moduleFactories.electronUpdater())
vi.mock('./electron-updater-loader', () => moduleFactories.electronUpdaterLoader())
vi.mock('../ipc/pty/provider/kill-all', () => moduleFactories.ptyKillAll())
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

describe('updater', () => {
  beforeEach(() => {
    resetUpdaterMocks()
  })

  // Why: dev tags exist only in their own repos, where the source's main repo 404s every one.
  it('verifies a dev-channel pin against the repo its feed reads', async () => {
    const platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    try {
      appMock.getVersion.mockReturnValue('1.4.160')
      const send = vi.fn()
      const { setupAutoUpdater, checkForUpdatesFromMenu } = await loadUpdaterModule()
      setupAutoUpdater(updaterMainWindow(send), {
        // ast-grep-ignore: test-no-wall-clock -- Suppress unrelated startup check.
        getLastUpdateCheckAt: () => Date.now()
      })

      checkForUpdatesFromMenu({ channel: 'hourly', targetTag: 'v1.4.160-hourly.202607281400' })

      await vi.waitFor(() => {
        expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1)
      })
      expect(verifyReleaseTagManifestMock).toHaveBeenCalledWith(
        expect.objectContaining({
          tag: 'v1.4.160-hourly.202607281400',
          version: '1.4.160-hourly.202607281400',
          repo: 'stablyai/orca-hourly'
        }),
        expect.objectContaining({ id: 'upstream' })
      )
      expect(autoUpdaterMock.setFeedURL).toHaveBeenLastCalledWith({
        provider: 'generic',
        url: 'https://github.com/stablyai/orca-hourly/releases/download/v1.4.160-hourly.202607281400',
        expectedVersion: '1.4.160-hourly.202607281400'
      })
      expect(send).not.toHaveBeenCalledWith(
        'updater:status',
        expect.objectContaining({ state: 'error' })
      )
    } finally {
      platformSpy.mockRestore()
    }
  })
})
