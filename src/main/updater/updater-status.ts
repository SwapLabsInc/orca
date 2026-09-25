import { app } from 'electron'
import { loadElectronAutoUpdater } from '../electron-updater-loader'
import { createMacSelfUpdateEngineIfSupported } from './mac-self-update/mac-self-update-activation'
import type { UpdateEngine } from './update-engine'
import { statusesEqual } from '../updater-fallback'
import type { UpdateCheckOptions, UpdateStatus } from '../../shared/update-status-types'
import {
  getVersionReleaseSource,
  isMultiSourceBuild,
  type ReleaseSourceId
} from '../../shared/release-sources'
import type { UpdateCheckVariant } from './updater-types'
import { UpdaterState as BaseUpdaterState } from './updater-state'

export abstract class UpdaterStatus extends BaseUpdaterState {
  protected getAutoUpdater(): UpdateEngine {
    if (!this.autoUpdater) {
      // Why decided once: the conditions are fixed for the process, and the handlers bind to one engine.
      this.autoUpdater = createMacSelfUpdateEngineIfSupported() ?? loadElectronAutoUpdater()
    }
    return this.autoUpdater
  }

  protected clearAvailableUpdateContext(): void {
    this.availableVersion = null
    this.availableReleaseUrl = null
  }

  protected closeLocalBuildFeed(): void {
    const feed = this.activeLocalBuildFeed
    this.activeLocalBuildFeed = null
    if (feed) {
      void feed.close()
    }
  }

  /**
   * The source the running build was published from, derived from its version. Null when no
   * configured source owns it: the wire then says nothing rather than "upstream", and the
   * manual-install gate treats it as different from every target.
   */
  protected getRunningReleaseSource(): ReleaseSourceId | null {
    return getVersionReleaseSource(app.getVersion())
  }

  /**
   * The source a status refers to, or null when the wire should say nothing:
   * single-source builds never set it, and a routine result only carries it on
   * the states a card acts on, so absence always means "the running source".
   */
  protected getStatusReleaseSource(state: UpdateStatus['state']): ReleaseSourceId | null {
    // Why the local exclusion: a local build is no source's release, and stamping the running
    // source on it would let a source button claim the offer as its own.
    if (!isMultiSourceBuild() || this.activeUpdateSource === 'local') {
      return null
    }
    const running = this.getRunningReleaseSource()
    const active = this.activeReleaseSource ?? running
    if (active !== running) {
      return active
    }
    return state === 'available' ||
      state === 'downloading' ||
      state === 'downloaded' ||
      state === 'error'
      ? active
      : null
  }

  protected restoreReleaseUpdateSource(): void {
    this.closeLocalBuildFeed()
    this.activeUpdateSource = 'release'
    this.isPinnedBuildActive = false
    this.activeReleaseSource = null
    this.pinnedAutoDownloadPending = false
    if (this.autoUpdater) {
      this.autoUpdater.allowDowngrade = false
      this.autoUpdater.disableDifferentialDownload = false
      // Why: a pinned jump forces allowPrerelease on; leaving it set would opt
      // every later background check into the RC channel behind the user's back.
      this.autoUpdater.allowPrerelease = this.includePrereleaseActive
    }
  }

  protected sendLocalBuildErrorAndRestore(message: string, userInitiated?: boolean): void {
    this.clearAvailableUpdateContext()
    if (
      this.currentStatus.state !== 'error' ||
      this.currentStatus.message !== message ||
      this.currentStatus.userInitiated !== userInitiated ||
      this.currentStatus.source !== 'local'
    ) {
      this.sendStatus({ state: 'error', message, userInitiated, source: 'local' })
    }
    this.restoreReleaseUpdateSource()
  }

  protected clearPrereleaseFallbackContext(): void {
    this.pendingPrereleaseFallback = null
  }

  protected clearPendingUpdateNudge(): void {
    this.activeUpdateNudgeId = null
    this.awaitingNudgeCheckOutcome = false
    this._setPendingUpdateNudgeId?.(null)
  }

  protected deferPendingUpdateNudgeUntilRetry(): void {
    this.activeUpdateNudgeId = null
    this.awaitingNudgeCheckOutcome = false
  }

  protected clearPublishingWindowLastGoodCheck(): void {
    this.publishingWindowLastGoodCheck = null
  }

  protected getPublishingWindowLastGoodCheck(): { lastGoodTag: string } | null {
    return this.publishingWindowLastGoodCheck
  }

  protected getPersistedPendingUpdateNudgeId(): string | null {
    return this._getPendingUpdateNudgeId?.() ?? null
  }

  protected decorateStatusWithActiveNudge(status: UpdateStatus): UpdateStatus {
    // Why: only actionable/error states carry the nudge marker so the renderer knows a dismiss should ack the campaign; cycle-boundary states never need it.
    if (!this.activeUpdateNudgeId) {
      return status
    }
    if (
      status.state === 'idle' ||
      status.state === 'checking' ||
      status.state === 'not-available'
    ) {
      return status
    }
    return { ...status, activeNudgeId: this.activeUpdateNudgeId }
  }

  /** `force` re-delivers a status the renderer must not miss even when it repeats the current one. */
  protected sendStatus(status: UpdateStatus, options?: { force?: boolean }): void {
    const pendingUserInitiatedCheckVariant = this.pendingUserInitiatedCheckAfterInFlight
    const shouldLaunchPendingUserInitiatedCheck =
      pendingUserInitiatedCheckVariant !== null &&
      (status.state === 'idle' ||
        status.state === 'not-available' ||
        status.state === 'available' ||
        status.state === 'error')
    const shouldPreserveNudgeForPublishingWindow =
      this.publishingWindowLastGoodCheck !== null &&
      (status.state === 'idle' ||
        status.state === 'not-available' ||
        status.state === 'available' ||
        status.state === 'error')
    if (this.awaitingNudgeCheckOutcome) {
      if (status.state === 'available') {
        if (shouldPreserveNudgeForPublishingWindow) {
          // Why: a last-good available update is only a temporary fallback; dismissing it must not consume the newest-release nudge campaign.
          this.deferPendingUpdateNudgeUntilRetry()
        } else {
          this.awaitingNudgeCheckOutcome = false
        }
      } else if (
        status.state === 'idle' ||
        status.state === 'not-available' ||
        status.state === 'error'
      ) {
        if (shouldPreserveNudgeForPublishingWindow) {
          // Why: last-good checks can say "not available" while the campaign's newest release is still publishing.
          this.deferPendingUpdateNudgeUntilRetry()
        } else {
          // Why: on no-update, mark the campaign dismissed so a nudge covering already-up-to-date users doesn't re-fire every 30-min poll.
          if (this.activeUpdateNudgeId) {
            this._setDismissedUpdateNudgeId?.(this.activeUpdateNudgeId)
          }
          this.clearPendingUpdateNudge()
        }
      }
    }

    const releaseSource = status.releaseSource ?? this.getStatusReleaseSource(status.state)
    const sourcedStatus: UpdateStatus = {
      ...status,
      ...(this.activeUpdateSource === 'release' ? {} : { source: this.activeUpdateSource }),
      ...(releaseSource ? { releaseSource } : {})
    }
    const decoratedStatus = this.decorateStatusWithActiveNudge(sourcedStatus)

    if (this.isUpdateCheckResultState(status.state)) {
      this.finishActiveUpdateCheckAttempt()
    }

    if (
      status.state === 'idle' ||
      status.state === 'not-available' ||
      status.state === 'available' ||
      status.state === 'error'
    ) {
      this.clearPublishingWindowLastGoodCheck()
    }

    // Why: reset the in-flight guard once status moves past the window where duplicate download() calls are possible.
    if (
      decoratedStatus.state === 'downloading' ||
      decoratedStatus.state === 'error' ||
      decoratedStatus.state === 'idle'
    ) {
      this.downloadInFlight = false
    }
    if (shouldLaunchPendingUserInitiatedCheck) {
      // Why: a forced status must still land before the queued check restarts the cycle.
      if (options?.force) {
        this.currentStatus = decoratedStatus
        this.mainWindowRef?.webContents.send('updater:status', decoratedStatus)
      }
      this.launchPendingUserInitiatedCheckAfterInFlight(pendingUserInitiatedCheckVariant)
      return
    }
    if (!options?.force && statusesEqual(this.currentStatus, decoratedStatus)) {
      return
    }
    this.currentStatus = decoratedStatus
    this.mainWindowRef?.webContents.send('updater:status', decoratedStatus)
    this.startPinnedAutoDownloadIfRequested(decoratedStatus)
  }

  /**
   * A cross-source install asked to download as soon as its pinned check found the
   * build. Left pending while the selection is still in progress, since
   * downloadUpdate() refuses to run then; the selection's finally block retries.
   */
  protected startPinnedAutoDownloadIfRequested(status: UpdateStatus): void {
    if (
      status.state !== 'available' ||
      !this.pinnedAutoDownloadPending ||
      this.pinnedBuildSelectionInProgress
    ) {
      return
    }
    this.pinnedAutoDownloadPending = false
    if (this.isPinnedBuildActive) {
      this.downloadUpdate()
    }
  }

  protected abstract finishActiveUpdateCheckAttempt(): void
  protected abstract isUpdateCheckResultState(state: UpdateStatus['state']): boolean
  protected abstract launchPendingUserInitiatedCheckAfterInFlight(variant: UpdateCheckVariant): void
  protected abstract checkForUpdatesFromMenu(options?: UpdateCheckOptions): void
  protected abstract downloadUpdate(): void
}
