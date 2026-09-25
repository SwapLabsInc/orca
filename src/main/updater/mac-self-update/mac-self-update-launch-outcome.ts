import { app } from 'electron'
import { existsSync } from 'node:fs'
import { recordUpdaterLifecycle } from '../../updater-lifecycle-diagnostics'
import {
  getMacSelfUpdateSupport,
  resolveRunningMacSelfUpdatePaths
} from './mac-self-update-activation'
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

let reported: MacSelfUpdateLaunchOutcome | null = null

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

/**
 * Runs once per launch, as soon as the app has a window (or, headless, shortly after start):
 * writes the health marker the helper is waiting for, reports how the previous launch's
 * install request ended, and clears its records so the next launch starts clean. Idempotent,
 * so the updater and the startup path may both ask for it in either order.
 */
export function reportMacSelfUpdateLaunchOutcome(): MacSelfUpdateLaunchOutcome {
  if (reported) {
    return reported
  }
  if (process.platform !== 'darwin' || !app.isPackaged) {
    reported = { kind: 'none' }
    return reported
  }
  let paths: MacSelfUpdatePaths
  let outcome: MacSelfUpdateLaunchOutcome
  try {
    paths = resolveRunningMacSelfUpdatePaths()
    outcome = resolveMacSelfUpdateLaunchOutcome(
      readMacSelfUpdateInstallState(paths.installStatePath),
      app.getVersion(),
      readMacSelfUpdateHelperOutcome(paths.helperOutcomePath)
    )
  } catch {
    // Why silent: no state means no pending install; the launch itself must not depend on this.
    reported = { kind: 'none' }
    return reported
  }
  try {
    if (outcome.kind === 'completed') {
      // Why first: the helper's 90 s clock is running; everything else here can wait.
      writeMacSelfUpdateHealthMarker(paths.healthMarkerPath, outcome.targetVersion)
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

/** The failure to show the user this session, if the previous launch's install did not take. */
export function getMacSelfUpdateLaunchFailure(): string | null {
  const outcome = reportMacSelfUpdateLaunchOutcome()
  return outcome.kind === 'failed' ? outcome.message : null
}
