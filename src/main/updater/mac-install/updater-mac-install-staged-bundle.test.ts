// @orca-isolated-worker
import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { app, autoUpdater, powerMonitor } from 'electron'
import { UpdaterSetup } from '../lifecycle/updater-setup'
import { MAC_DEFERRED_STAGING_TIMEOUT_MS } from '../lifecycle/updater-state'
import { beginMacUpdateDownload } from './updater-mac-install'

vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events')
  return {
    app: Object.assign(new EventEmitter(), { isPackaged: true, getVersion: () => '1.4.272' }),
    autoUpdater: new EventEmitter(),
    powerMonitor: new EventEmitter()
  }
})
vi.mock('./shipit-leftover-recovery', () => ({ prepareThisProcessShipItStaging: () => null }))
vi.mock('./macos-shipit-scheduling', () => ({ configureMacShipItScheduling: () => {} }))
vi.mock('../electron-updater-loader', () => ({ loadElectronAutoUpdater: () => engine }))
vi.mock('../releases/updater-prerelease-feed', () => ({
  fetchNewerReleaseTagsWithReadiness: async () => ({ state: 'ready', tags: [`v${version}`] })
}))
vi.mock('../releases/updater-changelog', () => ({ fetchChangelog: async () => null }))

const version = '1.4.273'
const engine = Object.assign(new EventEmitter(), {
  installerReadinessSource: 'staged-bundle' as const,
  setFeedURL: () => {},
  checkForUpdates: async () => {
    engine.emit('checking-for-update')
    engine.emit('update-available', { version })
  },
  downloadUpdate: async () => []
})
const hostPlatform = process.platform

beforeEach(() => {
  Object.defineProperty(process, 'platform', { value: 'darwin' })
})

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: hostPlatform })
  vi.clearAllTimers()
  vi.useRealTimers()
  autoUpdater.removeAllListeners()
  app.removeAllListeners()
  powerMonitor.removeAllListeners()
  engine.removeAllListeners()
  beginMacUpdateDownload()
})

it('takes a staged-bundle engine’s own ready event, and never promises an install on quit', async () => {
  // Keep the unrelated nudge fetch inside its startup cooldown.
  vi.useFakeTimers({ now: 0 })
  const updater = new UpdaterSetup()
  updater.setupAutoUpdater(null, { getLastUpdateCheckAt: () => Date.now() })

  updater.checkForUpdatesFromMenu()
  await vi.advanceTimersByTimeAsync(0)
  updater.downloadUpdate()
  engine.emit('update-downloaded', { version })
  vi.advanceTimersByTime(MAC_DEFERRED_STAGING_TIMEOUT_MS)

  const status = updater.getUpdateStatus()
  expect(status).toMatchObject({ state: 'downloaded', version })
  expect(status).not.toHaveProperty('installOnQuit')
})
