import { recordUpdaterLifecycle } from '../../updater-lifecycle-diagnostics'
import { MacSelfUpdateError } from './mac-self-update-failure'
import {
  MAC_SELF_UPDATE_HEALTH_TIMEOUT_SECONDS,
  MAC_SELF_UPDATE_RELAUNCH_PROGRAM,
  spawnMacSelfUpdateHelper,
  type HelperSpawner
} from './mac-self-update-helper'
import {
  clearMacSelfUpdateInstallRecords,
  writeMacSelfUpdateInstallState
} from './mac-self-update-install-state'
import type { MacSelfUpdatePaths } from './mac-self-update-paths'

export type MacSelfUpdateInstallRequest = {
  paths: MacSelfUpdatePaths
  appPid: number
  currentVersion: string
  staged: { appPath: string; version: string }
  /** False when a serve supervisor relaunches; the helper then only swaps. */
  helperRelaunches: boolean
  relaunchProgram?: string
  spawnHelper?: HelperSpawner
}

/**
 * Records the install request for the next launch to report on, then starts the detached
 * helper that swaps the bundles once this process has exited. Returns the helper's pid; a
 * failure before the helper runs leaves no request behind, so nothing is reported later.
 */
export function requestMacSelfUpdateInstall(request: MacSelfUpdateInstallRequest): number {
  const { paths, staged, helperRelaunches } = request
  const relaunchOwner = helperRelaunches ? 'helper' : 'supervisor'
  try {
    clearMacSelfUpdateInstallRecords(paths)
    writeMacSelfUpdateInstallState(paths.installStatePath, {
      schemaVersion: 1,
      phase: 'install-requested',
      fromVersion: request.currentVersion,
      targetVersion: staged.version,
      stagedAppPath: staged.appPath,
      relaunchOwner,
      requestedAt: new Date().toISOString()
    })
  } catch (error) {
    throw new MacSelfUpdateError(
      'install-state-unwritable',
      `Could not record the update install: ${error instanceof Error ? error.message : String(error)}`
    )
  }
  let helperPid: number
  try {
    helperPid = spawnMacSelfUpdateHelper(
      {
        appPid: request.appPid,
        appPath: paths.appPath,
        stagedAppPath: staged.appPath,
        rollbackAppPath: paths.rollbackAppPath,
        healthMarkerPath: paths.healthMarkerPath,
        outcomePath: paths.helperOutcomePath,
        executableRelativePath: paths.executableRelativePath,
        relaunchProgram: helperRelaunches
          ? (request.relaunchProgram ?? MAC_SELF_UPDATE_RELAUNCH_PROGRAM)
          : null,
        healthTimeoutSeconds: MAC_SELF_UPDATE_HEALTH_TIMEOUT_SECONDS
      },
      request.spawnHelper
    )
  } catch (error) {
    clearMacSelfUpdateInstallRecords(paths)
    throw error
  }
  recordUpdaterLifecycle('mac_self_update_helper_started', {
    version: staged.version,
    helperPid,
    relaunchOwner
  })
  return helperPid
}
