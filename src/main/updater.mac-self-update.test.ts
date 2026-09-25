import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { loadUpdaterModule, warmUpdaterModule } from './updater-test-module-loader'
import { createUpdaterMainWindowFake } from './updater-main-window.fixture'
import { setReleaseSourcesLiteralForTest } from '../shared/release-sources.fixture'
import {
  createMacSelfUpdateEngineFixture,
  type MacSelfUpdateEngineFixture
} from './updater/mac-self-update/mac-self-update-engine.fixture'
import { MAC_SELF_UPDATE_HELPER_SCRIPT } from './updater/mac-self-update/mac-self-update-helper'
import type { UpdateEngine } from './updater/update-engine'

const {
  appMock,
  autoUpdaterMock,
  armExitWatchdogMock,
  chooseLocalBuildMock,
  fetchNewerReleaseTagsMock,
  moduleFactories,
  recordUpdaterLifecycleMock,
  resetUpdaterMocks
} = await vi.hoisted(async () => (await import('./updater-test-harness')).createUpdaterMocks())

type ActivationAnswers = {
  engine: UpdateEngine | null
  active: boolean
  launchFailure: string | null
}

/** What the activation module answers; each test sets it before loading the updater. */
const activation = vi.hoisted((): ActivationAnswers => ({
  engine: null,
  active: false,
  launchFailure: null
}))

// Why hoisted: the fixture's engine verifies versions against the registry its own import loaded,
// which is not the copy `vi.resetModules()` hands the updater.
vi.hoisted(async () => {
  const fixture = await import('../shared/release-sources.fixture')
  fixture.setReleaseSourcesLiteralForTest(fixture.FORK_RELEASE_SOURCES_LITERAL)
})

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
vi.mock('./startup/hydrate-shell-path', () => ({
  runWithLaunchPath: (action: () => unknown): unknown => action()
}))
vi.mock('./updater/mac-self-update/mac-self-update-activation', () => ({
  createMacSelfUpdateEngineIfSupported: () => activation.engine,
  getMacSelfUpdateSupport: () =>
    activation.active ? { supported: true } : { supported: false, reason: 'no-public-key' },
  isMacSelfUpdateActive: async () => activation.active,
  getMacSelfUpdateSourceFor: () => null
}))
vi.mock('./updater/mac-self-update/mac-self-update-launch-outcome', () => ({
  getMacSelfUpdateLaunchFailure: () => activation.launchFailure
}))

warmUpdaterModule()

const FORK_VERSION = '1.4.197-swaplabs.202609241530'
const FORK_TAG = 'swaplabs-v1.4.197+202609251200'
// The harness's feed URL builder does not percent-encode the tag; the engine derives both from it.
const FORK_FEED_URL = `https://github.com/SwapLabsInc/orca/releases/download/${FORK_TAG}`
const FORK_RELEASE_PAGE_URL = `https://github.com/SwapLabsInc/orca/releases/tag/${FORK_TAG}`

describe('updater with the macOS self-update engine', () => {
  let fixture: MacSelfUpdateEngineFixture | null = null
  let platformSpy: { mockRestore(): void } | null = null

  beforeEach(() => {
    resetUpdaterMocks()
    appMock.getVersion.mockReturnValue(FORK_VERSION)
    platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    activation.engine = null
    activation.active = false
    activation.launchFailure = null
  })

  afterEach(() => {
    platformSpy?.mockRestore()
    fixture?.cleanup()
    fixture = null
  })

  afterAll(() => {
    setReleaseSourcesLiteralForTest(null)
  })

  function activateEngine(options?: Parameters<typeof createMacSelfUpdateEngineFixture>[0]) {
    fixture = createMacSelfUpdateEngineFixture({ currentVersion: FORK_VERSION, ...options })
    activation.engine = fixture.engine
    activation.active = true
    return fixture
  }

  it('runs a routine check, download and restart through the engine and its helper', async () => {
    const { engine, spawnHelper, requestQuit, paths } = activateEngine()
    fetchNewerReleaseTagsMock.mockResolvedValue({ tags: [FORK_TAG], state: 'ready' })
    const { mainWindow, send } = createUpdaterMainWindowFake()
    const { setupAutoUpdater, checkForUpdates, downloadUpdate, quitAndInstall } =
      await loadUpdaterModule()
    setupAutoUpdater(mainWindow, { getLastUpdateCheckAt: () => Date.now() })

    checkForUpdates()
    await vi.waitFor(() => {
      expect(send).toHaveBeenCalledWith('updater:status', {
        state: 'available',
        version: fixture!.targetVersion,
        changelog: null,
        releaseSource: 'swaplabs'
      })
    })
    // The atom-feed preflight pinned the fork tag; the engine read that tag's manifest.
    expect(fetchNewerReleaseTagsMock).toHaveBeenCalledWith(
      FORK_VERSION,
      2,
      expect.objectContaining({ source: expect.objectContaining({ id: 'swaplabs' }) })
    )
    expect(fixture!.fetchedUrls[0]).toBe(`${FORK_FEED_URL}/swaplabs-update-mac-arm64.json`)
    expect(autoUpdaterMock.checkForUpdates).not.toHaveBeenCalled()

    downloadUpdate()
    await vi.waitFor(() => {
      expect(send).toHaveBeenCalledWith('updater:status', {
        state: 'downloaded',
        version: fixture!.targetVersion,
        releaseUrl: undefined,
        releaseSource: 'swaplabs'
      })
    })
    expect(send).toHaveBeenCalledWith(
      'updater:status',
      expect.objectContaining({ state: 'downloading', version: fixture!.targetVersion })
    )
    // The engine's own update-downloaded is the installer-ready signal: no Squirrel wait.
    expect(recordUpdaterLifecycleMock).toHaveBeenCalledWith(
      'update_downloaded',
      expect.objectContaining({ macInstallerReady: true })
    )

    quitAndInstall()
    await vi.waitFor(() => {
      expect(requestQuit).toHaveBeenCalledTimes(1)
    })
    expect(spawnHelper).toHaveBeenCalledTimes(1)
    const [program, args] = spawnHelper.mock.calls[0]
    expect(program).toBe('/bin/sh')
    expect(args[1]).toBe(MAC_SELF_UPDATE_HELPER_SCRIPT)
    expect(args).toContain(paths.appPath)
    expect(args).toContain('/usr/bin/open')
    // The install committed, so the exit watchdog guards the quit like every other platform's.
    expect(armExitWatchdogMock).toHaveBeenCalledTimes(1)
    expect(engine.autoRunAppAfterInstall).toBe(true)
  })

  it('surfaces a refused manifest as a non-retryable error that points at the release page', async () => {
    activateEngine({ signWithForeignKey: true })
    fetchNewerReleaseTagsMock.mockResolvedValue({ tags: [FORK_TAG], state: 'ready' })
    const { mainWindow, send } = createUpdaterMainWindowFake()
    const { setupAutoUpdater, checkForUpdatesFromMenu } = await loadUpdaterModule()
    setupAutoUpdater(mainWindow, { getLastUpdateCheckAt: () => Date.now() })

    checkForUpdatesFromMenu()

    await vi.waitFor(() => {
      expect(send).toHaveBeenCalledWith('updater:status', {
        state: 'error',
        message: expect.stringContaining('not signed by the SwapLabs release key'),
        userInitiated: true,
        retryable: false,
        manualInstallUrl: FORK_RELEASE_PAGE_URL,
        releaseSource: 'swaplabs'
      })
    })
  })

  it('lists the running source as in-app once the engine is active', async () => {
    activateEngine()
    const { setupAutoUpdater, listReleaseSources } = await loadUpdaterModule()
    setupAutoUpdater(createUpdaterMainWindowFake().mainWindow)

    const rows = await listReleaseSources()
    expect(rows.map((row) => [row.id, row.install])).toEqual([
      ['upstream', 'manual-installer'],
      ['swaplabs', 'in-app']
    ])
  })

  it("shows what the previous launch's install came to, before any check runs", async () => {
    activateEngine()
    activation.launchFailure =
      'Orca could not update to 1.4.197-swaplabs.202609251200: the new build did not start within its time limit, so the previous build was restored. You are still running 1.4.197-swaplabs.202609241530.'
    const { mainWindow, send } = createUpdaterMainWindowFake()
    const { setupAutoUpdater } = await loadUpdaterModule()
    setupAutoUpdater(mainWindow, { getLastUpdateCheckAt: () => Date.now() })

    expect(send).toHaveBeenCalledWith('updater:status', {
      state: 'error',
      message: activation.launchFailure,
      userInitiated: true,
      releaseSource: 'swaplabs'
    })
  })

  // Why: the loopback feed serves latest-mac.yml, which the engine cannot verify; before the
  // refusal, the switch failed after the file dialog with a 404 for the signed manifest.
  it('refuses local-build switching while the engine is active, before any dialog opens', async () => {
    const { fetchedUrls } = activateEngine()
    const { mainWindow, send } = createUpdaterMainWindowFake()
    const { setupAutoUpdater, checkForUpdatesFromMenu } = await loadUpdaterModule()
    setupAutoUpdater(mainWindow, { getLastUpdateCheckAt: () => Date.now() })

    checkForUpdatesFromMenu({ localBuild: true })

    await vi.waitFor(() => {
      expect(send).toHaveBeenCalledWith(
        'updater:status',
        expect.objectContaining({
          state: 'error',
          message: expect.stringContaining('signed with the SwapLabs release identity'),
          userInitiated: true,
          source: 'local'
        })
      )
    })
    expect(chooseLocalBuildMock).not.toHaveBeenCalled()
    expect(fetchedUrls).toEqual([])
    expect(autoUpdaterMock.checkForUpdates).not.toHaveBeenCalled()
  })

  it('keeps electron-updater when the engine is not supported', async () => {
    fetchNewerReleaseTagsMock.mockResolvedValue({ tags: [FORK_TAG], state: 'ready' })
    const { mainWindow } = createUpdaterMainWindowFake()
    const { setupAutoUpdater, checkForUpdates, listReleaseSources } = await loadUpdaterModule()
    setupAutoUpdater(mainWindow, { getLastUpdateCheckAt: () => Date.now() })

    checkForUpdates()
    await vi.waitFor(() => {
      expect(autoUpdaterMock.checkForUpdates).toHaveBeenCalledTimes(1)
    })
    expect(autoUpdaterMock.setFeedURL).toHaveBeenLastCalledWith({
      provider: 'generic',
      url: FORK_FEED_URL
    })
    const rows = await listReleaseSources()
    expect(rows.map((row) => row.install)).toEqual(['manual-installer', 'manual-installer'])
  })
})
