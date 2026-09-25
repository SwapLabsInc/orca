import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { loadUpdaterModule, warmUpdaterModule } from './updater-test-module-loader'
import { createUpdaterMainWindowFake } from './updater-main-window.fixture'
import {
  FORK_RELEASE_SOURCES_LITERAL,
  setReleaseSourcesLiteralForTest
} from '../shared/release-sources.fixture'

const { appMock, autoUpdaterMock, fetchNewerReleaseTagsMock, moduleFactories, resetUpdaterMocks } =
  await vi.hoisted(async () => (await import('./updater-test-harness')).createUpdaterMocks())

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

warmUpdaterModule()

const FORK_VERSION = '1.4.197-swaplabs.202609241530.resume.1'
const FORK_TAG = 'swaplabs-v1.4.197+resume.1'
const FORK_PINNED_URL =
  'https://github.com/SwapLabsInc/orca/releases/download/swaplabs-v1.4.197%2Bresume.1'
const toSwapLabs = {
  channel: 'stable',
  targetTag: FORK_TAG,
  source: 'swaplabs',
  targetVersion: FORK_VERSION
} as const

function asMultiSourceBuild(runningVersion: string): void {
  setReleaseSourcesLiteralForTest(FORK_RELEASE_SOURCES_LITERAL)
  appMock.getVersion.mockReturnValue(runningVersion)
}

describe('updater cross-source install', () => {
  beforeEach(() => {
    resetUpdaterMocks()
  })

  afterEach(() => {
    setReleaseSourcesLiteralForTest(null)
  })

  it('pins a cross-source build with allowDowngrade and reports the target source', async () => {
    const platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')
    try {
      asMultiSourceBuild('1.4.197')
      autoUpdaterMock.checkForUpdates.mockImplementation(() => {
        autoUpdaterMock.emit('checking-for-update')
        autoUpdaterMock.emit('update-available', { version: FORK_VERSION })
        return Promise.resolve(undefined)
      })
      const { mainWindow, send } = createUpdaterMainWindowFake()
      const { setupAutoUpdater, checkForUpdatesFromMenu } = await loadUpdaterModule()
      setupAutoUpdater(mainWindow, {
        getLastUpdateCheckAt: () => Date.now()
      })

      checkForUpdatesFromMenu(toSwapLabs)

      await vi.waitFor(() => {
        expect(send).toHaveBeenCalledWith('updater:status', {
          state: 'available',
          version: FORK_VERSION,
          changelog: null,
          releaseSource: 'swaplabs'
        })
      })
      expect(send).toHaveBeenCalledWith('updater:status', {
        state: 'checking',
        userInitiated: true,
        releaseSource: 'swaplabs'
      })
      // Why allowDowngrade: the fork version is semver-below upstream's stable, and that is the point.
      expect(autoUpdaterMock.allowDowngrade).toBe(true)
      expect(autoUpdaterMock.setFeedURL).toHaveBeenLastCalledWith({
        provider: 'generic',
        url: FORK_PINNED_URL
      })
      expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1)
    } finally {
      platformSpy.mockRestore()
    }
  })

  // Why: the dev picker lists the primary source's builds without naming a source, so an omitted
  // source on install must resolve the same way or every listed tag is looked up on the fork.
  it('resolves an omitted source to the primary source, as the build list does', async () => {
    const platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')
    try {
      asMultiSourceBuild(FORK_VERSION)
      const { mainWindow } = createUpdaterMainWindowFake()
      const { setupAutoUpdater, checkForUpdatesFromMenu } = await loadUpdaterModule()
      setupAutoUpdater(mainWindow, {
        getLastUpdateCheckAt: () => Date.now()
      })

      checkForUpdatesFromMenu({ channel: 'stable', targetTag: 'v1.4.197' })

      await vi.waitFor(() => {
        expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1)
      })
      expect(autoUpdaterMock.setFeedURL).toHaveBeenLastCalledWith({
        provider: 'generic',
        url: 'https://github.com/stablyai/orca/releases/download/v1.4.197'
      })
    } finally {
      platformSpy.mockRestore()
    }
  })

  it('pins a fork build back to upstream on Linux', async () => {
    const platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')
    try {
      asMultiSourceBuild(FORK_VERSION)
      const { mainWindow, send } = createUpdaterMainWindowFake()
      const { setupAutoUpdater, checkForUpdatesFromMenu } = await loadUpdaterModule()
      setupAutoUpdater(mainWindow, {
        getLastUpdateCheckAt: () => Date.now()
      })

      checkForUpdatesFromMenu({ channel: 'stable', targetTag: 'v1.4.197', source: 'upstream' })

      await vi.waitFor(() => {
        expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1)
      })
      expect(autoUpdaterMock.setFeedURL).toHaveBeenLastCalledWith({
        provider: 'generic',
        url: 'https://github.com/stablyai/orca/releases/download/v1.4.197'
      })
      expect(send).toHaveBeenCalledWith('updater:status', {
        state: 'checking',
        userInitiated: true,
        releaseSource: 'upstream'
      })
    } finally {
      platformSpy.mockRestore()
    }
  })

  it.each([
    [
      'not-available',
      () => {
        autoUpdaterMock.emit('checking-for-update')
        autoUpdaterMock.emit('update-not-available')
        return Promise.resolve(undefined)
      },
      { state: 'not-available', userInitiated: true, releaseSource: 'upstream' }
    ],
    [
      'a failed check',
      () => Promise.reject(new Error('upstream feed failed')),
      {
        state: 'error',
        message: 'upstream feed failed',
        userInitiated: true,
        releaseSource: 'upstream'
      }
    ]
  ] as const)(
    'restores the running source after %s on a cross-source jump',
    async (_label, checkImplementation, expectedStatus) => {
      const platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')
      try {
        asMultiSourceBuild(FORK_VERSION)
        autoUpdaterMock.checkForUpdates.mockImplementationOnce(checkImplementation)
        fetchNewerReleaseTagsMock.mockResolvedValue(['swaplabs-v1.4.197+resume.2'])
        const { mainWindow, send } = createUpdaterMainWindowFake()
        const { setupAutoUpdater, checkForUpdates, checkForUpdatesFromMenu } =
          await loadUpdaterModule()
        setupAutoUpdater(mainWindow, {
          getLastUpdateCheckAt: () => Date.now()
        })

        checkForUpdatesFromMenu({ channel: 'stable', targetTag: 'v1.4.197', source: 'upstream' })
        await vi.waitFor(() => {
          expect(send).toHaveBeenCalledWith('updater:status', expectedStatus)
        })
        expect(autoUpdaterMock.allowDowngrade).toBe(false)

        // The next routine check is back on the fork's own feed.
        checkForUpdates()
        await vi.waitFor(() => {
          expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(2)
        })
        expect(fetchNewerReleaseTagsMock).toHaveBeenLastCalledWith(
          FORK_VERSION,
          2,
          expect.objectContaining({ source: expect.objectContaining({ id: 'swaplabs' }) })
        )
        expect(autoUpdaterMock.setFeedURL).toHaveBeenLastCalledWith({
          provider: 'generic',
          url: 'https://github.com/SwapLabsInc/orca/releases/download/swaplabs-v1.4.197+resume.2'
        })
      } finally {
        platformSpy.mockRestore()
      }
    }
  )

  it('restores the running source when a cross-source offer is dismissed', async () => {
    const platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')
    try {
      asMultiSourceBuild('1.4.197')
      autoUpdaterMock.checkForUpdates.mockImplementation(() => {
        autoUpdaterMock.emit('checking-for-update')
        autoUpdaterMock.emit('update-available', { version: FORK_VERSION })
        return Promise.resolve(undefined)
      })
      fetchNewerReleaseTagsMock.mockResolvedValue(['v1.4.198'])
      const { mainWindow, send } = createUpdaterMainWindowFake()
      const { setupAutoUpdater, checkForUpdates, checkForUpdatesFromMenu, dismissAvailableUpdate } =
        await loadUpdaterModule()
      setupAutoUpdater(mainWindow, {
        getLastUpdateCheckAt: () => Date.now()
      })

      checkForUpdatesFromMenu(toSwapLabs)
      await vi.waitFor(() => {
        expect(send).toHaveBeenCalledWith(
          'updater:status',
          expect.objectContaining({ state: 'available', releaseSource: 'swaplabs' })
        )
      })

      dismissAvailableUpdate()
      expect(send).toHaveBeenCalledWith('updater:status', { state: 'idle' })
      expect(autoUpdaterMock.allowDowngrade).toBe(false)

      autoUpdaterMock.checkForUpdates.mockReset().mockResolvedValue(undefined)
      checkForUpdates()
      await vi.waitFor(() => {
        expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1)
      })
      expect(fetchNewerReleaseTagsMock).toHaveBeenLastCalledWith('1.4.197', 1, {
        includePrerelease: false
      })
      expect(autoUpdaterMock.setFeedURL).toHaveBeenLastCalledWith({
        provider: 'generic',
        url: 'https://github.com/stablyai/orca/releases/download/v1.4.198'
      })
    } finally {
      platformSpy.mockRestore()
    }
  })

  it('auto-downloads a cross-source pinned build exactly once', async () => {
    const platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')
    try {
      asMultiSourceBuild('1.4.197')
      autoUpdaterMock.checkForUpdates.mockImplementation(() => {
        autoUpdaterMock.emit('checking-for-update')
        autoUpdaterMock.emit('update-available', { version: FORK_VERSION })
        return Promise.resolve(undefined)
      })
      autoUpdaterMock.downloadUpdate.mockResolvedValue(undefined)
      const { mainWindow, send } = createUpdaterMainWindowFake()
      const { setupAutoUpdater, checkForUpdatesFromMenu, downloadUpdate } =
        await loadUpdaterModule()
      setupAutoUpdater(mainWindow, {
        getLastUpdateCheckAt: () => Date.now()
      })

      checkForUpdatesFromMenu({ ...toSwapLabs, autoDownload: true })

      await vi.waitFor(() => {
        expect(send).toHaveBeenCalledWith('updater:status', {
          state: 'downloading',
          percent: 0,
          version: FORK_VERSION,
          releaseSource: 'swaplabs'
        })
      })
      expect(autoUpdaterMock.downloadUpdate).toHaveBeenCalledTimes(1)

      // A second click, a repeated event, and the card's own download button all collapse into the one in flight.
      checkForUpdatesFromMenu({ ...toSwapLabs, autoDownload: true })
      autoUpdaterMock.emit('update-available', { version: FORK_VERSION })
      downloadUpdate()
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(autoUpdaterMock.downloadUpdate).toHaveBeenCalledTimes(1)
      expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1)
    } finally {
      platformSpy.mockRestore()
    }
  })

  // Why: Squirrel.Mac only installs a bundle carrying the running app's signature, and
  // each source signs with its own identity, so the download must never start.
  it.each([
    ['upstream to SwapLabs', '1.4.197', toSwapLabs, 'swaplabs', FORK_TAG, 'SwapLabsInc/orca'],
    [
      'SwapLabs to upstream',
      FORK_VERSION,
      { channel: 'stable', targetTag: 'v1.4.197', source: 'upstream' } as const,
      'upstream',
      'v1.4.197',
      'stablyai/orca'
    ]
  ])(
    'refuses every macOS cross-source jump (%s) and points at the release page',
    async (_label, runningVersion, options, targetSource, tag, repo) => {
      const platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
      try {
        asMultiSourceBuild(runningVersion)
        const { mainWindow, send } = createUpdaterMainWindowFake()
        const { setupAutoUpdater, checkForUpdatesFromMenu } = await loadUpdaterModule()
        setupAutoUpdater(mainWindow, {
          getLastUpdateCheckAt: () => Date.now()
        })

        checkForUpdatesFromMenu(options)

        expect(send).toHaveBeenCalledWith('updater:status', {
          state: 'error',
          message: expect.stringContaining('install it by hand'),
          userInitiated: true,
          releaseSource: targetSource,
          manualInstallUrl: `https://github.com/${repo}/releases/tag/${encodeURIComponent(tag)}`
        })
        expect(autoUpdaterMock.checkForUpdates).not.toHaveBeenCalled()
        expect(autoUpdaterMock.allowDowngrade).toBe(false)
      } finally {
        platformSpy.mockRestore()
      }
    }
  )

  // Why: a version no configured source owns stays unknown — the wire says nothing, and macOS
  // refuses the jump — rather than reading the build as an outdated upstream one.
  it('keeps an unrecognised running version unknown on the wire and in the macOS gate', async () => {
    const platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    try {
      asMultiSourceBuild('1.4.197-nightly.202609241530')
      const { mainWindow, send } = createUpdaterMainWindowFake()
      const { setupAutoUpdater, checkForUpdatesFromMenu, getRemoteServerUpdaterSnapshot } =
        await loadUpdaterModule()
      setupAutoUpdater(mainWindow, {
        getLastUpdateCheckAt: () => Date.now()
      })

      expect(getRemoteServerUpdaterSnapshot('runtime-1')).not.toHaveProperty('releaseSource')

      checkForUpdatesFromMenu({ channel: 'stable', targetTag: 'v1.4.197', source: 'upstream' })
      expect(send).toHaveBeenCalledWith('updater:status', {
        state: 'error',
        message: expect.stringContaining('install it by hand'),
        userInitiated: true,
        releaseSource: 'upstream',
        manualInstallUrl: 'https://github.com/stablyai/orca/releases/tag/v1.4.197'
      })
      expect(autoUpdaterMock.checkForUpdates).not.toHaveBeenCalled()
    } finally {
      platformSpy.mockRestore()
    }
  })

  it('rejects an unknown release source and a dev channel on a non-primary source', async () => {
    const platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    try {
      asMultiSourceBuild('1.4.197')
      const { mainWindow, send } = createUpdaterMainWindowFake()
      const { setupAutoUpdater, checkForUpdatesFromMenu } = await loadUpdaterModule()
      setupAutoUpdater(mainWindow, {
        getLastUpdateCheckAt: () => Date.now()
      })

      // Why releaseSource here: on a multi-source build every error names the source it concerns.
      checkForUpdatesFromMenu({ channel: 'stable', targetTag: 'v1.4.197', source: 'nope' })
      expect(send).toHaveBeenCalledWith('updater:status', {
        state: 'error',
        message: 'Unknown release source "nope".',
        userInitiated: true,
        releaseSource: 'upstream'
      })

      checkForUpdatesFromMenu({ ...toSwapLabs, channel: 'hourly' })
      expect(send).toHaveBeenCalledWith('updater:status', {
        state: 'error',
        message: 'SwapLabs publishes no Hourly channel.',
        userInitiated: true,
        releaseSource: 'upstream'
      })
      expect(autoUpdaterMock.checkForUpdates).not.toHaveBeenCalled()
    } finally {
      platformSpy.mockRestore()
    }
  })
})
