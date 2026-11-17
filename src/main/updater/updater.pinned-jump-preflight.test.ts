import type { getReleaseDownloadUrl } from './releases/updater-release-readiness'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { loadUpdaterModule, warmUpdaterModule } from './testing/updater-test-module-loader'
import { createUpdaterMainWindowFake } from '../updater-main-window.fixture'

const {
  autoUpdaterMock,
  fetchNewerReleaseTagsMock,
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

  /** A startup background check whose feed preflight is still in flight. */
  async function startBackgroundCheckInPreflight(): Promise<{
    resolvePreflight: (tags: string[]) => void
    send: ReturnType<typeof createUpdaterMainWindowFake>['send']
    updater: Awaited<ReturnType<typeof loadUpdaterModule>>
  }> {
    let resolvePreflight: (tags: string[]) => void = () => {}
    fetchNewerReleaseTagsMock.mockImplementationOnce(
      () =>
        new Promise<string[]>((resolve) => {
          resolvePreflight = resolve
        })
    )
    const { mainWindow, send } = createUpdaterMainWindowFake()
    const updater = await loadUpdaterModule()
    updater.setupAutoUpdater(mainWindow, {
      // ast-grep-ignore: test-no-wall-clock -- A check older than the interval makes the startup check due.
      getLastUpdateCheckAt: () => Date.now() - 25 * 60 * 60 * 1000
    })
    expect(fetchNewerReleaseTagsMock).toHaveBeenCalledTimes(1)
    expect(autoUpdaterMock.checkForUpdates).not.toHaveBeenCalled()
    return { resolvePreflight: (tags) => resolvePreflight(tags), send, updater }
  }

  // Why: a preflight runs outside 'checking', so a late one could repoint the jump's pinned feed.
  it('lets a pinned jump supersede a background check still in feed preflight', async () => {
    const platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')
    try {
      autoUpdaterMock.checkForUpdates.mockImplementation(() => {
        autoUpdaterMock.emit('checking-for-update')
        return Promise.resolve(undefined)
      })
      const { resolvePreflight, updater } = await startBackgroundCheckInPreflight()

      updater.checkForUpdatesFromMenu({ channel: 'stable', targetTag: 'v1.0.50' })
      await vi.waitFor(() => {
        expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1)
      })
      const pinnedFeed = {
        provider: 'generic',
        url: 'https://github.com/stablyai/orca/releases/download/v1.0.50',
        expectedVersion: '1.0.50'
      }
      expect(autoUpdaterMock.setFeedURL).toHaveBeenLastCalledWith(pinnedFeed)

      resolvePreflight(['v1.0.52'])
      await new Promise((resolve) => setTimeout(resolve, 0))

      expect(autoUpdaterMock.setFeedURL).toHaveBeenLastCalledWith(pinnedFeed)
      expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1)

      // The pinned check settles, hands the feed back, and routine checks resume.
      autoUpdaterMock.emit('update-not-available')
      updater.checkForUpdates()
      await vi.waitFor(() => {
        expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(2)
      })
    } finally {
      platformSpy.mockRestore()
    }
  })

  // Why: the jump must own the attempt before its manifest read yields to a finishing preflight.
  it('supersedes a background preflight before the pinned manifest probe resolves', async () => {
    const platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')
    try {
      let resolveProbe: (verdict: { kind: 'ready' }) => void = () => {}
      verifyReleaseTagManifestMock.mockImplementationOnce(
        () =>
          new Promise<{ kind: 'ready' }>((resolve) => {
            resolveProbe = resolve
          })
      )
      autoUpdaterMock.checkForUpdates.mockImplementation(() => {
        autoUpdaterMock.emit('checking-for-update')
        return Promise.resolve(undefined)
      })
      const { resolvePreflight, updater } = await startBackgroundCheckInPreflight()

      updater.checkForUpdatesFromMenu({ channel: 'stable', targetTag: 'v1.0.50' })
      await vi.waitFor(() => {
        expect(verifyReleaseTagManifestMock).toHaveBeenCalledTimes(1)
      })
      autoUpdaterMock.setFeedURL.mockClear()

      resolvePreflight(['v1.0.52'])
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(autoUpdaterMock.setFeedURL).not.toHaveBeenCalled()
      expect(autoUpdaterMock.checkForUpdates).not.toHaveBeenCalled()

      resolveProbe({ kind: 'ready' })
      await vi.waitFor(() => {
        expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1)
      })
      expect(autoUpdaterMock.setFeedURL).toHaveBeenCalledTimes(1)
      expect(autoUpdaterMock.setFeedURL).toHaveBeenLastCalledWith({
        provider: 'generic',
        url: 'https://github.com/stablyai/orca/releases/download/v1.0.50',
        expectedVersion: '1.0.50'
      })
    } finally {
      platformSpy.mockRestore()
    }
  })

  // Why: a pin settling mid-preflight ends the attempt; a stale launch flag deferred later checks.
  it('does not strand background checks when a pinned jump settles during a preflight', async () => {
    const platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')
    try {
      const { resolvePreflight, send, updater } = await startBackgroundCheckInPreflight()

      updater.checkForUpdatesFromMenu({ channel: 'stable', targetTag: 'v1.0.51' })
      expect(send).toHaveBeenCalledWith('updater:status', {
        state: 'not-available',
        userInitiated: true
      })

      resolvePreflight(['v1.0.52'])
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(autoUpdaterMock.checkForUpdates).not.toHaveBeenCalled()

      updater.checkForUpdatesFromMenu()
      await vi.waitFor(() => {
        expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1)
      })
      expect(fetchNewerReleaseTagsMock).toHaveBeenCalledTimes(2)
    } finally {
      platformSpy.mockRestore()
    }
  })
})
