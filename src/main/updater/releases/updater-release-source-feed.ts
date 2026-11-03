import { app } from 'electron'
import {
  getReleaseSourceOrPrimary,
  isMultiSourceBuild,
  type ReleaseSource
} from '../../../shared/release-sources'
import { UpdaterInstallExecution } from '../lifecycle/updater-install-execution'
import type { UpdateCheckVariant } from '../lifecycle/updater-types'
import { recordRoutineCheckSkippedForUnknownSource } from '../updater-release-sources'
import { getReleaseDownloadUrl } from './updater-release-readiness'

/** LOCAL: the release source a routine check reads, and what that source changes about the check. */
type RoutineReleaseFeed = {
  currentVersion: string
  source: ReleaseSource
  isPrimarySource: boolean
  isPerfCheck: boolean
  forcePrerelease: boolean
}

/** LOCAL: the fork's side of `pinDefaultReleaseFeed`, whose upstream file sits at its line limit. */
export abstract class UpdaterReleaseSourceFeed extends UpdaterInstallExecution {
  /** Null when no configured source owns this build, so a routine check has no feed to read. */
  protected resolveRoutineReleaseFeed(variant: UpdateCheckVariant): RoutineReleaseFeed | null {
    const currentVersion = app.getVersion()
    const runningSource = this.getRunningReleaseSource()
    if (runningSource === null && isMultiSourceBuild()) {
      // Why not the primary: no configured source owns this build, so no feed is its own, and the
      // primary's would offer upstream's release over it. Only an explicit pinned jump may cross.
      this.clearPrereleaseFallbackContext()
      this.clearPublishingWindowLastGoodCheck()
      recordRoutineCheckSkippedForUnknownSource(currentVersion, variant)
      return null
    }
    // Why sticky: routine checks only ever read the running build's own source, so a fork build is never offered upstream's newer semver.
    const source = getReleaseSourceOrPrimary(runningSource)
    const isPrimarySource = source.prereleaseIdentifier === null
    // Why: perf builds and the rc series exist only in the primary source; elsewhere every build is a prerelease.
    const isPerfCheck = variant === 'perf' && isPrimarySource
    return {
      currentVersion,
      source,
      isPrimarySource,
      isPerfCheck,
      forcePrerelease: isPerfCheck || !isPrimarySource
    }
  }

  protected getRunningSourceDownloadUrl(tag: string): string {
    return getReleaseDownloadUrl(tag, getReleaseSourceOrPrimary(this.getRunningReleaseSource()))
  }

  protected reportPreflightSuperseded(currentVersion: string): 'superseded' {
    console.info(`[updater] release feed preflight superseded: current=${currentVersion}`)
    return 'superseded'
  }
}
