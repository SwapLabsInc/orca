import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as UpdaterModule from './updater'
import type { LinuxPackageType } from './linux-update-package-type'
import { loadUpdaterModule, warmUpdaterModule } from './updater-test-module-loader'

const { appMock, getLinuxPackageTypeMock, moduleFactories, resetUpdaterMocks } = await vi.hoisted(
  async () => (await import('./updater-test-harness')).createUpdaterMocks()
)

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

const HELP_URL = 'https://example.com/runbooks/orca-update'
const MANUAL_HEADLESS = {
  installMode: 'unsupported-headless-serve',
  automatic: false,
  reason: 'manual-service-update-required'
}

warmUpdaterModule()

describe('server update help link on the remote-update support', () => {
  beforeEach(() => {
    resetUpdaterMocks()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  async function startUpdater(
    installMode: UpdaterModule.UpdateInstallMode,
    helpUrl?: string
  ): Promise<typeof UpdaterModule> {
    if (helpUrl !== undefined) {
      vi.stubEnv('ORCA_SERVER_UPDATE_HELP_URL', helpUrl)
    }
    const updater = await loadUpdaterModule()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the updater only reaches `webContents.send` on its window, and electron itself is mocked.
    updater.setupAutoUpdater({ webContents: { send: vi.fn() } } as never, {
      getLastUpdateCheckAt: () => Date.now(),
      installMode
    })
    return updater
  }

  it('publishes the link from a headless host that cannot update itself', async () => {
    const updater = await startUpdater('unsupported-headless-serve', HELP_URL)

    expect(updater.getRemoteServerUpdateSupport()).toEqual({
      ...MANUAL_HEADLESS,
      helpUrl: HELP_URL
    })
    expect(updater.getRemoteServerUpdaterSnapshot('runtime-1').support).toEqual({
      ...MANUAL_HEADLESS,
      helpUrl: HELP_URL
    })
  })

  it.each(['deb', 'rpm', 'unusable'] as const satisfies readonly LinuxPackageType[])(
    'publishes the link from a %s install that needs a manual update',
    async (packageType) => {
      getLinuxPackageTypeMock.mockReturnValue(packageType)
      const updater = await startUpdater('interactive', HELP_URL)

      expect(updater.getRemoteServerUpdateSupport()).toEqual({
        installMode: 'interactive',
        automatic: false,
        reason: 'manual-service-update-required',
        helpUrl: HELP_URL
      })
    }
  )

  it('leaves the key off the wire when the variable is unset', async () => {
    const updater = await startUpdater('unsupported-headless-serve')
    const support = updater.getRemoteServerUpdateSupport()

    expect(support).toEqual(MANUAL_HEADLESS)
    expect(Object.keys(support)).toEqual(['installMode', 'automatic', 'reason'])
    expect(JSON.stringify(support)).toBe(JSON.stringify(MANUAL_HEADLESS))
    expect(console.warn).not.toHaveBeenCalled()
  })

  it.each([
    ['http', 'http://example.com/runbook'],
    ['relative', '/runbooks/orca-update'],
    ['control characters', 'https://example.com/\nrunbook'],
    ['over-long', `https://example.com/${'a'.repeat(2048)}`]
  ])('leaves the key off the wire for an invalid value (%s), warning once', async (_l, value) => {
    const updater = await startUpdater('unsupported-headless-serve', value)

    const support = updater.getRemoteServerUpdateSupport()
    updater.getRemoteServerUpdateSupport()
    updater.getRemoteServerUpdaterSnapshot('runtime-1')

    expect(Object.keys(support)).toEqual(['installMode', 'automatic', 'reason'])
    expect(console.warn).toHaveBeenCalledOnce()
  })

  it('never publishes the link from a host that updates automatically', async () => {
    const updater = await startUpdater('interactive', HELP_URL)
    const support = updater.getRemoteServerUpdateSupport()

    expect(support).toEqual({ installMode: 'interactive', automatic: true, reason: 'available' })
    expect(support).not.toHaveProperty('helpUrl')
  })

  it('never publishes the link for a manual reason that is not the deployment', async () => {
    appMock.isPackaged = false
    const unpackaged = await startUpdater('unsupported-headless-serve', HELP_URL)
    expect(unpackaged.getRemoteServerUpdateSupport()).toEqual({
      installMode: 'unsupported-headless-serve',
      automatic: false,
      reason: 'unpackaged-build'
    })
  })

  it('still refuses remote control on a manual host that publishes a link', async () => {
    const updater = await startUpdater('unsupported-headless-serve', HELP_URL)

    expect(() => updater.checkForRemoteServerUpdate('runtime-1')).toThrow(
      'remote_update_manual_required'
    )
  })
})
