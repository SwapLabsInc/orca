import type { ProgressInfo, UpdateDownloadedEvent, UpdateInfo } from 'electron-updater'
import type { ElectronAutoUpdater } from '../electron-updater-loader'

/** The electron-updater events the state machine listens to, with electron-updater's own payloads. */
export type UpdateEngineEvents = {
  error: (error: Error, message?: string) => void
  'checking-for-update': () => void
  'update-not-available': (info: UpdateInfo) => void
  'update-available': (info: UpdateInfo) => void
  'update-downloaded': (event: UpdateDownloadedEvent) => void
  'download-progress': (info: ProgressInfo) => void
}

/** The feed a check reads: one concrete release tag's download directory. */
export type UpdateEngineFeed = {
  provider: 'generic'
  url: string
  /**
   * LOCAL: the exact version a pinned jump expects the feed to install, so an engine
   * that reads the manifest itself can refuse anything else. electron-updater ignores it;
   * its pinned checks are verified against the tag's manifest before the feed is set.
   */
  expectedVersion?: string
}

/**
 * The slice of electron-updater's `AppUpdater` the updater state machine drives.
 * electron-updater satisfies it as is; LOCAL: so does Orca's own macOS installer
 * for SwapLabs builds, which emits the same events so every handler, guard and
 * the quit-and-install sequence run unchanged.
 */
export type UpdateEngine = {
  autoDownload: boolean
  autoInstallOnAppQuit: boolean
  autoRunAppAfterInstall: boolean
  allowPrerelease: boolean
  allowDowngrade: boolean
  disableDifferentialDownload: boolean
  logger: ElectronAutoUpdater['logger']
  on<E extends keyof UpdateEngineEvents>(event: E, listener: UpdateEngineEvents[E]): UpdateEngine
  /**
   * LOCAL: `'staged-bundle'` means the engine emits `update-downloaded` only once the new
   * bundle is staged and verified, so that event is the installer-ready signal Squirrel.Mac's
   * native `update-downloaded` would otherwise provide.
   */
  readonly installerReadinessSource?: 'staged-bundle'
  setFeedURL(options: UpdateEngineFeed): void
  checkForUpdates(): Promise<unknown>
  downloadUpdate(): Promise<unknown>
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void
}
