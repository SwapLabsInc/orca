import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { loadUpdaterModule, warmUpdaterModule } from './updater-test-module-loader'
import { createUpdaterMainWindowFake } from './updater-main-window.fixture'
import {
  FORK_RELEASE_SOURCES_LITERAL,
  setReleaseSourcesLiteralForTest
} from '../shared/release-sources.fixture'

const {
  appMock,
  autoUpdaterMock,
  fetchNewerReleaseTagsMock,
  moduleFactories,
  recordUpdaterLifecycleMock,
  resetUpdaterMocks,
  verifyReleaseTagManifestMock
} = await vi.hoisted(async () => (await import('./updater-test-harness')).createUpdaterMocks())

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

  // Why: the staged AppImage stays registered with electron-updater's quit handler; a routine check
  // that unpinned it would say "latest" while quitting still installs the other source's build.
  it('keeps a staged cross-source build pinned when a routine check is requested', async () => {
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
      const { setupAutoUpdater, checkForUpdatesFromMenu, getUpdateStatus } =
        await loadUpdaterModule()
      setupAutoUpdater(mainWindow, {
        getLastUpdateCheckAt: () => Date.now()
      })

      checkForUpdatesFromMenu({ ...toSwapLabs, autoDownload: true })
      await vi.waitFor(() => {
        expect(send).toHaveBeenCalledWith(
          'updater:status',
          expect.objectContaining({ state: 'downloading', version: FORK_VERSION })
        )
      })
      autoUpdaterMock.emit('update-downloaded', { version: FORK_VERSION })
      expect(getUpdateStatus()).toMatchObject({ state: 'downloaded', version: FORK_VERSION })
      send.mockClear()

      checkForUpdatesFromMenu()
      await new Promise((resolve) => setTimeout(resolve, 0))

      expect(getUpdateStatus()).toMatchObject({
        state: 'downloaded',
        version: FORK_VERSION,
        releaseSource: 'swaplabs'
      })
      expect(send).not.toHaveBeenCalledWith(
        'updater:status',
        expect.objectContaining({ state: 'checking' })
      )
      expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1)
      expect(autoUpdaterMock.allowDowngrade).toBe(true)
    } finally {
      platformSpy.mockRestore()
    }
  })

  // Why: Squirrel.Mac only installs a bundle carrying the running app's signature, and Windows
  // Authenticode-checks an installer against the installed app's publisher; each source signs
  // with its own identity, so the download must never start.
  it.each([
    [
      'upstream to SwapLabs on macOS',
      'darwin',
      '1.4.197',
      toSwapLabs,
      'swaplabs',
      FORK_TAG,
      'SwapLabsInc/orca',
      'Orca on macOS'
    ],
    [
      'SwapLabs to upstream on macOS',
      'darwin',
      FORK_VERSION,
      { channel: 'stable', targetTag: 'v1.4.197', source: 'upstream' } as const,
      'upstream',
      'v1.4.197',
      'stablyai/orca',
      'Orca on macOS'
    ],
    [
      'upstream to SwapLabs on Windows',
      'win32',
      '1.4.197',
      toSwapLabs,
      'swaplabs',
      FORK_TAG,
      'SwapLabsInc/orca',
      'Orca on Windows'
    ],
    [
      'SwapLabs to upstream on Windows',
      'win32',
      FORK_VERSION,
      { channel: 'stable', targetTag: 'v1.4.197', source: 'upstream' } as const,
      'upstream',
      'v1.4.197',
      'stablyai/orca',
      'Orca on Windows'
    ]
  ] as const)(
    'refuses every cross-source jump (%s) and points at the release page',
    async (_label, platform, runningVersion, options, targetSource, tag, repo, messagePart) => {
      const platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue(platform)
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
          message: expect.stringMatching(new RegExp(`^${messagePart}.*by hand\\.$`)),
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

  // Why: the picker names no source, which resolves to the primary — and the refusal must name
  // that publisher, not the running build's, or the status points at a page of one source with
  // the label of another.
  it('names the primary source when a refused jump omitted it', async () => {
    const platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    try {
      asMultiSourceBuild(FORK_VERSION)
      const { mainWindow, send } = createUpdaterMainWindowFake()
      const { setupAutoUpdater, checkForUpdatesFromMenu } = await loadUpdaterModule()
      setupAutoUpdater(mainWindow, {
        getLastUpdateCheckAt: () => Date.now()
      })

      checkForUpdatesFromMenu({ channel: 'stable', targetTag: 'v1.4.197' })

      expect(send).toHaveBeenCalledWith('updater:status', {
        state: 'error',
        message: expect.stringContaining('Orca upstream builds are signed differently'),
        userInitiated: true,
        releaseSource: 'upstream',
        manualInstallUrl: 'https://github.com/stablyai/orca/releases/tag/v1.4.197'
      })
      expect(recordUpdaterLifecycleMock).toHaveBeenCalledWith('cross_source_install_refused', {
        from: 'swaplabs',
        to: 'upstream',
        tag: 'v1.4.197'
      })
      expect(autoUpdaterMock.checkForUpdates).not.toHaveBeenCalled()
    } finally {
      platformSpy.mockRestore()
    }
  })

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

  // Why: a version no configured source owns has no feed of its own. Reading the primary's instead
  // would offer upstream's release over the fork build on every startup, wake, and menu check.
  it('never reads a feed for a routine check when no configured source owns the running build', async () => {
    const platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')
    try {
      const runningVersion = '1.4.197-nightly.202609241530'
      asMultiSourceBuild(runningVersion)
      const { mainWindow, send } = createUpdaterMainWindowFake()
      const { setupAutoUpdater, checkForUpdates, checkForUpdatesFromMenu } =
        await loadUpdaterModule()
      setupAutoUpdater(mainWindow, {
        getLastUpdateCheckAt: () => Date.now()
      })
      autoUpdaterMock.setFeedURL.mockClear()

      checkForUpdates()
      await vi.waitFor(() => {
        expect(recordUpdaterLifecycleMock).toHaveBeenCalledWith(
          'routine_check_skipped_unknown_source',
          { current: runningVersion, variant: 'default' },
          expect.objectContaining({ level: 'warn' })
        )
      })
      checkForUpdatesFromMenu()
      await vi.waitFor(() => {
        expect(send).toHaveBeenCalledWith('updater:status', {
          state: 'not-available',
          userInitiated: true
        })
      })
      expect(fetchNewerReleaseTagsMock).not.toHaveBeenCalled()
      expect(autoUpdaterMock.checkForUpdates).not.toHaveBeenCalled()
      expect(autoUpdaterMock.setFeedURL).not.toHaveBeenCalled()

      // An explicit pinned jump still crosses: the dev named the source and the tag.
      checkForUpdatesFromMenu({ channel: 'stable', targetTag: 'v1.4.197', source: 'upstream' })
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

  // Why: the picker's version comes from a release title, and a tag's `latest*.yml` is whatever was
  // uploaded under it; the manifest alone says what electron-updater would install.
  it.each([
    [
      { kind: 'mismatch', manifestVersion: '1.4.197' },
      `advertises ${FORK_VERSION}, but its update manifest installs 1.4.197`
    ],
    [{ kind: 'not-ready' }, 'has no installable build for this platform yet'],
    [{ kind: 'unavailable' }, 'Could not read the SwapLabs release']
  ] as const)(
    'refuses a pinned build whose manifest does not prove the advertised version (%o)',
    async (verdict, messagePart) => {
      const platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')
      try {
        asMultiSourceBuild('1.4.197')
        verifyReleaseTagManifestMock.mockResolvedValue(verdict)
        const { mainWindow, send } = createUpdaterMainWindowFake()
        const { setupAutoUpdater, checkForUpdates, checkForUpdatesFromMenu } =
          await loadUpdaterModule()
        setupAutoUpdater(mainWindow, {
          getLastUpdateCheckAt: () => Date.now()
        })
        autoUpdaterMock.setFeedURL.mockClear()

        checkForUpdatesFromMenu({ ...toSwapLabs, autoDownload: true })

        await vi.waitFor(() => {
          expect(send).toHaveBeenCalledWith('updater:status', {
            state: 'error',
            message: expect.stringContaining(messagePart),
            userInitiated: true,
            releaseSource: 'swaplabs'
          })
        })
        expect(verifyReleaseTagManifestMock).toHaveBeenCalledWith(
          expect.objectContaining({
            tag: FORK_TAG,
            version: FORK_VERSION,
            repo: 'SwapLabsInc/orca'
          }),
          expect.objectContaining({ id: 'swaplabs' })
        )
        expect(recordUpdaterLifecycleMock).toHaveBeenCalledWith(
          'pinned_build_refused',
          expect.objectContaining({ source: 'swaplabs', tag: FORK_TAG, verdict: verdict.kind }),
          { level: 'warn' }
        )
        expect(autoUpdaterMock.setFeedURL).not.toHaveBeenCalled()
        expect(autoUpdaterMock.checkForUpdates).not.toHaveBeenCalled()
        expect(autoUpdaterMock.downloadUpdate).not.toHaveBeenCalled()
        expect(autoUpdaterMock.allowDowngrade).toBe(false)

        // The running source's routine checks are back.
        checkForUpdates()
        await vi.waitFor(() => {
          expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1)
        })
        expect(fetchNewerReleaseTagsMock).toHaveBeenLastCalledWith('1.4.197', 1, {
          includePrerelease: false
        })
      } finally {
        platformSpy.mockRestore()
      }
    }
  )

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
