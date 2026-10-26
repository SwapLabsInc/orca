import { app } from 'electron'
import { isMacInstallRequested } from '../updater-mac-install'
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

export abstract class UpdaterMenuChecks extends UpdaterScheduling {
  protected checkForUpdatesFromMenu(options?: UpdateCheckOptions): void {
    if (
      this.pendingQuitAndInstallTimer ||
      this.quitAndInstallInProgress ||
      isMacInstallRequested()
    ) {
      return
    }
    if (!app.isPackaged) {
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
    // Why: a staged pinned build stays registered with electron-updater's quit handler, so unpinning
    // here would report "latest" while quitting still installs it. It is restarted into or not at all.
    if (this.isPinnedBuildActive && this.currentStatus.state === 'downloaded') {
      return
    }
    this.restoreReleaseUpdateSource()

    const checkVariant = this.getUpdateCheckVariant(options)
    if (checkVariant === 'prerelease') {
      this.clearPrereleaseFallbackContext()
      this.enableIncludePrerelease()
    } else if (checkVariant === 'perf') {
      this.clearPrereleaseFallbackContext()
      // Perf checks need prerelease manifests without changing future default/background channels.
      this.enablePrereleaseManifestChecks()
    }

    const checkAlreadyInFlight =
      this.backgroundCheckLaunchPending || this.currentStatus.state === 'checking'
    this.userInitiatedCheck = true
    // Manual checks are campaign-independent; clear the marker so dismiss cannot consume a nudge.
    this.activeUpdateNudgeId = null
    // Acknowledge before feed pinning/events; status equality dedupes broadcasts.
    this.sendStatus({ state: 'checking', userInitiated: true })
    if (checkAlreadyInFlight) {
      this.backgroundCheckPromotedToUserInitiated = true
      this.rearmActiveUpdateCheckStallTimer()
      if (checkVariant !== 'default') {
        // The active check may pin stable; queue a fresh modifier check for the requested channel.
        this.pendingUserInitiatedCheckAfterInFlight = checkVariant
      }
      return
    }

    const attemptId = this.beginUpdateCheckAttempt()
    const autoUpdater = this.getAutoUpdater()
    const launch = (): Promise<unknown> | undefined => {
      if (
        this.pendingQuitAndInstallTimer ||
        this.quitAndInstallInProgress ||
        isMacInstallRequested()
      ) {
        return undefined
      }
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
