import { app } from 'electron'
import { is } from '@electron-toolkit/utils'
import {
  DEV_CHANNEL_PLATFORM_LABEL,
  getReleaseRepoForChannel,
  getVersionChannel,
  hasDedicatedReleaseRepo,
  isChannelSupportedOnPlatform,
  RELEASE_CHANNEL_LABELS,
  requiresManualInstall,
  type ReleaseBuild,
  type ReleaseChannel
} from '../../shared/release-channel'
import {
  getReleaseSource,
  getReleaseSourceOrPrimary,
  PRIMARY_RELEASE_SOURCE,
  type ReleaseSource
} from '../../shared/release-sources'
import type { ReleaseSourceStatus } from '../../shared/update-status-types'
import { compareVersions } from '../updater-fallback'
import { recordUpdaterLifecycle } from '../updater-lifecycle-diagnostics'
import {
  verifyReleaseTagManifest,
  type ReleaseTagManifestVerdict
} from '../updater-prerelease-feed'
import { listReleaseBuilds, resolveTargetBuild } from '../updater-release-builds'
import { ReleaseBuildListCache, type ReleaseBuildListOptions } from '../updater-release-build-cache'
import { getReleaseTagPageUrl } from '../updater-release-urls'
import {
  getMacSelfUpdateSupport,
  isMacSelfUpdateActive
} from './mac-self-update/mac-self-update-activation'
import { UpdaterMenuChecks, type PinnedBuildTarget } from './updater-menu-checks'
import { listReleaseSourceStatuses } from './updater-release-sources'

/** Why a message per verdict: the dev picked this tag by hand, so the refusal must say what the release actually holds. */
function describeRefusedPinnedManifest(
  verdict: Exclude<ReleaseTagManifestVerdict, { kind: 'ready' }>,
  tag: string,
  version: string,
  source: ReleaseSource
): string {
  const release = `${source.prereleaseIdentifier === null ? '' : `${source.label} `}release "${tag}"`
  switch (verdict.kind) {
    case 'mismatch':
      return `The ${release} advertises ${version}, but its update manifest installs ${verdict.manifestVersion}. Nothing was installed.`
    case 'not-ready':
      return `The ${release} has no installable build for this platform yet.`
    case 'unavailable':
      return `Could not read the ${release} manifest. Check your connection and try again.`
  }
}

/** Why per platform: each names the signature check the downloaded build would fail. */
function describeRefusedCrossSourceJump(source: ReleaseSource): string {
  if (process.platform === 'win32') {
    return `Orca on Windows only installs updates signed by the running build's publisher, and ${source.label} builds are signed differently. Download the ${source.label} installer from its release page and run it by hand.`
  }
  return `Orca on macOS can only install updates carrying the same code signature, and ${source.label} builds are signed differently. Download the ${source.label} build from its release page and install it by hand.`
}

/** Handles local-build selection and exact release-channel/tag jumps. */
export abstract class UpdaterBuildSelection extends UpdaterMenuChecks {
  private readonly releaseBuildCache = new ReleaseBuildListCache((channel, sourceId) =>
    listReleaseBuilds(channel, process.platform, getReleaseSourceOrPrimary(sourceId), process.arch)
  )

  protected async checkForLocalBuildFromMenu(): Promise<void> {
    if (process.platform !== 'darwin') {
      this.sendLocalBuildErrorAndRestore(
        'Local build switching is currently available only on macOS.',
        true
      )
      return
    }
    if (this.currentStatus.state === 'checking' || this.currentStatus.state === 'downloading') {
      return
    }
    if (this.localBuildSelectionInProgress) {
      return
    }
    this.localBuildSelectionInProgress = true
    try {
      const [{ chooseLocalBuild }, { startLocalBuildFeed }] = await Promise.all([
        import('../local-builds/local-build-switch'),
        import('../local-builds/local-build-feed-server')
      ])
      const candidate = await chooseLocalBuild(this.mainWindowRef)
      if (!candidate) {
        return
      }
      this.closeLocalBuildFeed()
      const feed = await startLocalBuildFeed(candidate)
      this.activeLocalBuildFeed = feed
      this.activeUpdateSource = 'local'
      this.clearPrereleaseFallbackContext()
      this.clearPublishingWindowLastGoodCheck()
      this.clearAvailableUpdateContext()
      this.activeUpdateNudgeId = null
      this.userInitiatedCheck = true
      this.sendStatus({ state: 'checking', userInitiated: true })

      const updater = this.getAutoUpdater()
      updater.allowDowngrade = true
      updater.disableDifferentialDownload = true
      updater.setFeedURL({ provider: 'generic', url: feed.url })
      const attemptId = this.beginUpdateCheckAttempt()
      this.markUpdateCheckLaunched(attemptId)
      await updater.checkForUpdates()
      this.handleSettledUpdateCheckPromise(attemptId)
    } catch (error) {
      this.userInitiatedCheck = false
      this.sendLocalBuildErrorAndRestore(String((error as Error)?.message ?? error), true)
    } finally {
      this.localBuildSelectionInProgress = false
    }
  }

  protected async listAvailableReleaseBuilds(
    channel: ReleaseChannel,
    options?: ReleaseBuildListOptions
  ): Promise<ReleaseBuild[]> {
    return this.releaseBuildCache.list(channel, options)
  }

  /** Every configured source with its newest stable build, read through the shared list cache. */
  protected async listReleaseSources(
    options?: Pick<ReleaseBuildListOptions, 'force'>
  ): Promise<ReleaseSourceStatus[]> {
    return listReleaseSourceStatuses(
      (source, force) => this.releaseBuildCache.list('stable', { force, source: source.id }),
      options?.force === true,
      await isMacSelfUpdateActive()
    )
  }

  /**
   * Why the pinned build refuses before pinning: electron-updater would otherwise take the jump all
   * the way to a download and fail it with a raw signature error. Each refusal names where to get
   * the build by hand — run once, in-app updates work from there on.
   */
  private refusePinnedBuild(target: PinnedBuildTarget, source: ReleaseSource): void {
    const repo = getReleaseRepoForChannel(target.channel, source.id)
    recordUpdaterLifecycle('cross_source_install_refused', {
      from: this.getRunningReleaseSource(),
      to: source.id,
      tag: target.tag
    })
    // Why the resolved id, even when the request named none: an omitted source is the primary,
    // and the status must name the publisher whose installer it points at.
    this.sendStatus({
      state: 'error',
      message: describeRefusedCrossSourceJump(source),
      userInitiated: true,
      releaseSource: source.id,
      manualInstallUrl: getReleaseTagPageUrl(repo, target.tag)
    })
  }

  /** Pins the updater at one exact release tag and checks it, so a dev can move to any published build on any channel — including an older one. */
  protected async checkForPinnedBuild(target: PinnedBuildTarget): Promise<void> {
    const { channel, tag } = target
    if (!app.isPackaged || is.dev) {
      this.sendStatus({ state: 'not-available', userInitiated: true })
      return
    }
    // Why primary, not the running source: an omitted source must match listBuilds' default, or the
    // picker on a fork build lists upstream tags and then resolves them against the fork.
    const source = target.source ? getReleaseSource(target.source) : PRIMARY_RELEASE_SOURCE
    if (!source) {
      this.sendStatus({
        state: 'error',
        message: `Unknown release source "${target.source}".`,
        userInitiated: true
      })
      return
    }
    // Why here as well as in the picker: the renderer disables the option, but IPC is reachable regardless, and there is no artifact to install on a platform the dev workflows do not build for.
    if (!isChannelSupportedOnPlatform(channel, process.platform)) {
      this.sendStatus({
        state: 'error',
        message: `${RELEASE_CHANNEL_LABELS[channel]} builds are produced only for ${DEV_CHANNEL_PLATFORM_LABEL}.`,
        userInitiated: true
      })
      return
    }
    // Why: dev channels are the primary source's; another source is one series and has no such repo.
    if (source.prereleaseIdentifier !== null && hasDedicatedReleaseRepo(channel)) {
      this.sendStatus({
        state: 'error',
        message: `${source.label} publishes no ${RELEASE_CHANNEL_LABELS[channel]} channel.`,
        userInitiated: true
      })
      return
    }
    const runningSource = this.getRunningReleaseSource()
    // Why only await a candidate: the gate stays synchronous everywhere the custom installer cannot apply.
    const macSelfUpdate = getMacSelfUpdateSupport().supported && (await isMacSelfUpdateActive())
    if (
      requiresManualInstall({
        platform: process.platform,
        running: { source: runningSource, channel: getVersionChannel(app.getVersion()) },
        target: { source: source.id, channel },
        macSelfUpdate
      })
    ) {
      if (source.id !== runningSource) {
        this.refusePinnedBuild(target, source)
        return
      }
      this.sendStatus({
        state: 'error',
        message: `${RELEASE_CHANNEL_LABELS[channel]} builds are unsigned, and this signed build only installs updates signed by Orca's publisher. Download the installer from the release page and run it once — updates work normally from there, including back to Stable.`,
        userInitiated: true
      })
      return
    }
    if (this.currentStatus.state === 'checking' || this.currentStatus.state === 'downloading') {
      return
    }
    if (this.localBuildSelectionInProgress || this.pinnedBuildSelectionInProgress) {
      return
    }
    this.pinnedBuildSelectionInProgress = true
    try {
      const resolved = resolveTargetBuild(channel, tag, source, target.version)
      if (compareVersions(resolved.version, app.getVersion()) === 0) {
        this.sendSettledCheckStatus({ state: 'not-available', userInitiated: true })
        return
      }
      this.closeLocalBuildFeed()
      this.activeUpdateSource = hasDedicatedReleaseRepo(channel) ? channel : 'release'
      this.isPinnedBuildActive = true
      this.activeReleaseSource = source.id
      this.pinnedAutoDownloadPending = target.autoDownload
      this.clearPrereleaseFallbackContext()
      this.clearPublishingWindowLastGoodCheck()
      this.clearAvailableUpdateContext()
      this.activeUpdateNudgeId = null
      this.userInitiatedCheck = true
      this.sendStatus({ state: 'checking', userInitiated: true })
      if (source.id !== runningSource) {
        recordUpdaterLifecycle('cross_source_install_requested', {
          from: runningSource,
          to: source.id,
          tag,
          autoDownload: target.autoDownload
        })
      }
      // Why before the probe: a background check still in preflight is superseded now, so it cannot
      // pin its own feed while this one is off reading the manifest.
      const attemptId = this.beginUpdateCheckAttempt()
      // Why: the picker's version came from a title, and a tag's `latest*.yml` is whatever was
      // uploaded under it; only the manifest says what electron-updater would install. The
      // resolved target names the repo the pin reads, which for a dev channel is not the source's.
      const verdict = await verifyReleaseTagManifest(resolved, source)
      if (!this.isActiveUpdateCheckAttempt(attemptId)) {
        return
      }
      if (verdict.kind !== 'ready') {
        recordUpdaterLifecycle(
          'pinned_build_refused',
          {
            source: source.id,
            tag: resolved.tag,
            version: resolved.version,
            verdict: verdict.kind,
            ...(verdict.kind === 'mismatch' ? { manifestVersion: verdict.manifestVersion } : {})
          },
          { level: 'warn' }
        )
        throw new Error(
          describeRefusedPinnedManifest(verdict, resolved.tag, resolved.version, source)
        )
      }

      const updater = this.getAutoUpdater()
      // Why: an intentional jump to an older tag must not be filtered out as "not newer".
      updater.allowDowngrade = true
      updater.disableDifferentialDownload = true
      updater.allowPrerelease = true
      console.info(
        `[updater] pinned to ${source.id} ${channel} build ${resolved.tag} → ${resolved.feedUrl}`
      )
      // Why expectedVersion: an engine that reads the manifest itself must install this tag's build and nothing else.
      updater.setFeedURL({
        provider: 'generic',
        url: resolved.feedUrl,
        expectedVersion: resolved.version
      })
      this.availableReleaseUrl = resolved.feedUrl
      this.markUpdateCheckLaunched(attemptId)
      await updater.checkForUpdates()
      this.handleSettledUpdateCheckPromise(attemptId)
    } catch (error) {
      this.userInitiatedCheck = false
      const releaseSource = this.getPinnedReleaseSourceForStatus()
      this.clearAvailableUpdateContext()
      this.restoreReleaseUpdateSource()
      this.sendSettledCheckStatus({
        state: 'error',
        message: String((error as Error)?.message ?? error),
        userInitiated: true,
        ...(releaseSource ? { releaseSource } : {})
      })
    } finally {
      this.pinnedBuildSelectionInProgress = false
      // Why: electron-updater reports 'available' while checkForUpdates() is still awaited, and
      // downloadUpdate() refuses to run mid-selection — so a requested download starts here.
      this.startPinnedAutoDownloadIfRequested(this.currentStatus)
    }
  }
}
