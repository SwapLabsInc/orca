import { app } from 'electron'
import { is } from '@electron-toolkit/utils'
import type { UpdateCheckOptions } from '../../shared/update-status-types'
import type { ReleaseChannel } from '../../shared/release-channel'
import type { ReleaseSourceId } from '../../shared/release-sources'
import { UpdaterScheduling } from './updater-scheduling'

/** An exact build to pin: a tag in a channel, and for a cross-source jump the source and its listed version. */
export type PinnedBuildTarget = {
  channel: ReleaseChannel
  tag: string
  /** Null means the running build's own source. */
  source: ReleaseSourceId | null
  /** Null means "read it from the tag", which only primary-source tags allow. */
  version: string | null
  autoDownload: boolean
}

/** Handles checks initiated from the desktop menu and modifier-key variants. */
export abstract class UpdaterMenuChecks extends UpdaterScheduling {
  protected checkForUpdatesFromMenu(options?: UpdateCheckOptions): void {
    if (!app.isPackaged || is.dev) {
      this.sendStatus({ state: 'not-available', userInitiated: true })
      return
    }
    if (options?.localBuild) {
      void this.checkForLocalBuildFromMenu()
      return
    }
    if (options?.targetTag && options.channel) {
      void this.checkForPinnedBuild({
        channel: options.channel,
        tag: options.targetTag,
        source: options.source ?? null,
        version: options.targetVersion ?? null,
        autoDownload: options.autoDownload === true
      })
      return
    }
    if (this.localBuildSelectionInProgress || this.pinnedBuildSelectionInProgress) {
      return
    }
    if (
      this.activeUpdateSource !== 'release' &&
      (this.currentStatus.state === 'checking' || this.currentStatus.state === 'downloading')
    ) {
      return
    }
    this.restoreReleaseUpdateSource()

    const checkVariant = this.getUpdateCheckVariant(options)
    if (checkVariant === 'prerelease') {
      this.clearPrereleaseFallbackContext()
      this.enableIncludePrerelease()
    } else if (checkVariant === 'perf') {
      this.clearPrereleaseFallbackContext()
      // Why: perf checks need prerelease manifests now, but must not opt future default/background checks into the RC channel.
      this.enablePrereleaseManifestChecks()
    }

    const checkAlreadyInFlight =
      this.backgroundCheckLaunchPending || this.currentStatus.state === 'checking'
    this.userInitiatedCheck = true
    // Why: manual checks are nudge-independent; clear the marker so a later dismiss can't consume the campaign by accident.
    this.activeUpdateNudgeId = null
    // Why: respond visibly before feed pinning/updater events; duplicate broadcasts are suppressed by status equality below.
    this.sendStatus({ state: 'checking', userInitiated: true })
    if (checkAlreadyInFlight) {
      this.backgroundCheckPromotedToUserInitiated = true
      this.rearmActiveUpdateCheckStallTimer()
      if (checkVariant !== 'default') {
        // Why: in-flight check may have pinned the stable feed; queue a fresh modifier check to avoid a stale-channel result.
        this.pendingUserInitiatedCheckAfterInFlight = checkVariant
      }
      return
    }

    const attemptId = this.beginUpdateCheckAttempt()
    const autoUpdater = this.getAutoUpdater()
    const launch = (): Promise<unknown> | undefined => {
      if (!this.isActiveUpdateCheckAttempt(attemptId)) {
        return undefined
      }
      this.markUpdateCheckLaunched(attemptId)
      return autoUpdater.checkForUpdates()
    }
    const run = this.pinDefaultReleaseFeed(checkVariant, attemptId).then((preflightResult) => {
      if (preflightResult === 'superseded') {
        return false
      }
      if (preflightResult === 'not-available') {
        if (!this.isActiveUpdateCheckAttempt(attemptId)) {
          return false
        }
        this.userInitiatedCheck = false
        this.finishActiveUpdateCheckAttempt()
        this.recordCompletedUpdateCheck()
        this.sendSettledCheckStatus({ state: 'not-available', userInitiated: true })
        return false
      }
      return launch()
    })
    void Promise.resolve(run)
      .then((launchResult) => {
        if (launchResult === false) {
          return
        }
        this.handleSettledUpdateCheckPromise(attemptId)
      })
      .catch((err) => {
        if (!this.isActiveUpdateCheckAttempt(attemptId)) {
          return
        }
        this.userInitiatedCheck = false
        void this.sendCheckFailureStatus(String(err?.message ?? err), true, 'promise', err)
      })
  }

  protected abstract checkForLocalBuildFromMenu(): Promise<void>
  protected abstract checkForPinnedBuild(target: PinnedBuildTarget): Promise<void>
}
