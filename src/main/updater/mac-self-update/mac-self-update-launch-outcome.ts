import { app } from 'electron'
import { existsSync } from 'node:fs'
import { recordUpdaterLifecycle } from '../../updater-lifecycle-diagnostics'
import {
  getMacSelfUpdateSupport,
  resolveRunningMacSelfUpdatePaths
} from './mac-self-update-activation'
import { MAC_SELF_UPDATE_HEALTH_TIMEOUT_SECONDS } from './mac-self-update-helper'
import {
  clearMacSelfUpdateInstallRecords,
  pruneMacSelfUpdateRollback,
  pruneMacSelfUpdateWorkDirs,
  readMacSelfUpdateHelperOutcome,
  readMacSelfUpdateInstallState,
  resolveMacSelfUpdateLaunchOutcome,
  writeMacSelfUpdateHealthMarker,
  type MacSelfUpdateLaunchOutcome
} from './mac-self-update-install-state'
import type { MacSelfUpdatePaths } from './mac-self-update-paths'

/**
 * Why not prune the rollback at once: the helper is still watching for the marker, and its
 * timeout branch moves the rollback back into place. It has exited long before this fires.
 */
export const ROLLBACK_PRUNE_DELAY_MS = 3 * 60_000

/** How often a refused health-marker write is tried again while the helper is still waiting. */
export const HEALTH_MARKER_RETRY_MS = 5_000

let reported: MacSelfUpdateLaunchOutcome | null = null

/**
 * Why retry: the helper rolls this healthy build back when the marker is missing at its
 * deadline, so one refused write (a transient EAGAIN, a folder recreated a moment later) must
 * not decide that. Bounded by the helper's own clock, after which the retries would be moot.
 */
function writeHealthMarkerUntilItSticks(
  paths: MacSelfUpdatePaths,
  version: string,
  attempt = 1
): void {
  try {
    writeMacSelfUpdateHealthMarker(paths.healthMarkerPath, version)
    if (attempt > 1) {
      recordUpdaterLifecycle('mac_self_update_health_marker_written', { attempt })
    }
  } catch (error) {
    recordUpdaterLifecycle(
      'mac_self_update_health_marker_failed',
      { attempt, errorType: error instanceof Error ? error.name : typeof error },
      {
        level: 'warn',
        message: 'Could not write the launch health marker; the helper may roll back'
      }
    )
    if (attempt * HEALTH_MARKER_RETRY_MS >= MAC_SELF_UPDATE_HEALTH_TIMEOUT_SECONDS * 1000) {
      return
    }
    const timer = setTimeout(
      () => writeHealthMarkerUntilItSticks(paths, version, attempt + 1),
      HEALTH_MARKER_RETRY_MS
    )
    timer.unref?.()
  }
}

function schedulePruneRollback(paths: MacSelfUpdatePaths): void {
  const timer = setTimeout(() => {
    try {
      pruneMacSelfUpdateRollback(paths)
      recordUpdaterLifecycle('mac_self_update_rollback_pruned')
    } catch (error) {
      recordUpdaterLifecycle(
        'mac_self_update_rollback_prune_failed',
        { errorType: error instanceof Error ? error.name : typeof error },
        { level: 'warn', message: 'Could not remove the previous build kept for rollback' }
      )
    }
  }, ROLLBACK_PRUNE_DELAY_MS)
  timer.unref?.()
}

/** What the previous launch's install request came to, read from disk and nothing written. */
function peekMacSelfUpdateLaunchOutcome(): {
  paths: MacSelfUpdatePaths
  outcome: MacSelfUpdateLaunchOutcome
} | null {
  if (process.platform !== 'darwin' || !app.isPackaged) {
    return null
  }
  try {
    const paths = resolveRunningMacSelfUpdatePaths()
    return {
      paths,
      outcome: resolveMacSelfUpdateLaunchOutcome(
        readMacSelfUpdateInstallState(paths.installStatePath),
        app.getVersion(),
        readMacSelfUpdateHelperOutcome(paths.helperOutcomePath)
      )
    }
  } catch {
    // Why silent: no state means no pending install; the launch itself must not depend on this.
    return null
  }
}

/**
 * Runs once per launch, as soon as the first window can paint (`runOnlyAfterFirstWindowShown`):
 * writes the health marker the helper is waiting for, reports how the previous launch's
 * install request ended, and clears its records so the next launch starts clean. Idempotent,
 * so a second caller in the same launch changes nothing.
 */
export function reportMacSelfUpdateLaunchOutcome(): MacSelfUpdateLaunchOutcome {
  if (reported) {
    return reported
  }
  const peeked = peekMacSelfUpdateLaunchOutcome()
  if (!peeked) {
    reported = { kind: 'none' }
    return reported
  }
  const { paths, outcome } = peeked
  try {
    if (outcome.kind === 'completed') {
      // Why first: the helper's 90 s clock is running; everything else here can wait.
      writeHealthMarkerUntilItSticks(paths, outcome.targetVersion)
      recordUpdaterLifecycle('mac_self_update_completed', {
        from: outcome.fromVersion,
        to: outcome.targetVersion,
        helperOutcome: outcome.helperOutcome
      })
      schedulePruneRollback(paths)
    } else if (outcome.kind === 'failed') {
      recordUpdaterLifecycle(
        'mac_self_update_failed',
        {
          from: outcome.fromVersion,
          to: outcome.targetVersion,
          helperOutcome: outcome.helperOutcome
        },
        { level: 'warn', message: outcome.message }
      )
    } else if (getMacSelfUpdateSupport().supported && existsSync(paths.rollbackAppPath)) {
      // A rollback left behind by a launch that never got to prune it.
      schedulePruneRollback(paths)
    }
    if (outcome.kind !== 'completed') {
      pruneMacSelfUpdateWorkDirs(paths)
    }
    if (outcome.kind !== 'none') {
      // Why keep the marker: the helper may not have seen it yet; the request and record can go.
      clearMacSelfUpdateInstallRecords(paths, { keepHealthMarker: true })
    }
  } catch (error) {
    recordUpdaterLifecycle(
      'mac_self_update_launch_report_failed',
      { errorType: error instanceof Error ? error.name : typeof error },
      { level: 'warn', message: 'Could not record the self-update launch outcome' }
    )
  }
  reported = outcome
  return outcome
}

/**
 * The failure to show the user this session, if the previous launch's install did not take.
 * Why read-only: the updater can set up from a crash-loop fallback before any window has shown,
 * and the health marker must stay the first window's to write.
 */
export function getMacSelfUpdateLaunchFailure(): string | null {
  const outcome = reported ?? peekMacSelfUpdateLaunchOutcome()?.outcome ?? { kind: 'none' }
  return outcome.kind === 'failed' ? outcome.message : null
}
