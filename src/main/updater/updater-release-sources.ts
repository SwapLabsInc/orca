import { app } from 'electron'
import {
  getVersionChannel,
  requiresManualInstall,
  type ReleaseBuild
} from '../../shared/release-channel'
import {
  RELEASE_SOURCES,
  getVersionReleaseSource,
  type ReleaseSource,
  type ReleaseSourceId
} from '../../shared/release-sources'
import type {
  ReleaseSourceInstallMode,
  ReleaseSourceStatus
} from '../../shared/update-status-types'
import { isExternallyManagedLinuxInstall } from '../linux-update-package-type'
import { recordUpdaterLifecycle } from '../updater-lifecycle-diagnostics'
import type { UpdateCheckVariant } from './updater-types'

/**
 * Why main decides the install mode: it is the verdict `downloadUpdate` and the pinned check
 * refuse by, so the button that names the action cannot promise one this host cannot make.
 */
export function resolveReleaseSourceInstallMode(
  source: ReleaseSource,
  runningSource: ReleaseSourceId | null,
  /** LOCAL: Orca's own macOS installer can replace this build in place. */
  macSelfUpdate: boolean
): ReleaseSourceInstallMode {
  if (process.platform === 'linux' && isExternallyManagedLinuxInstall()) {
    return 'externally-managed'
  }
  return requiresManualInstall({
    platform: process.platform,
    running: { source: runningSource, channel: getVersionChannel(app.getVersion()) },
    target: { source: source.id, channel: 'stable' },
    macSelfUpdate
  })
    ? 'manual-installer'
    : 'in-app'
}

/**
 * Every configured source with its newest build for this platform. List failures are
 * returned per source as data, so one unreachable repository never hides the others.
 * Only the stable series is listed: dev channels belong to the primary source's picker.
 */
export async function listReleaseSourceStatuses(
  listStableBuilds: (source: ReleaseSource, force: boolean) => Promise<ReleaseBuild[]>,
  force: boolean,
  macSelfUpdate = false
): Promise<ReleaseSourceStatus[]> {
  const runningSource = getVersionReleaseSource(app.getVersion())
  return Promise.all(
    RELEASE_SOURCES.map(async (source): Promise<ReleaseSourceStatus> => {
      const status = {
        id: source.id,
        label: source.label,
        running: source.id === runningSource,
        install: resolveReleaseSourceInstallMode(source, runningSource, macSelfUpdate)
      }
      try {
        const builds = await listStableBuilds(source, force)
        return { ...status, latest: builds[0] ?? null, error: null }
      } catch (error) {
        return {
          ...status,
          latest: null,
          error: error instanceof Error ? error.message : String(error)
        }
      }
    })
  )
}

/** A routine check on a build no configured source owns reads no feed; the diagnostic says why. */
export function recordRoutineCheckSkippedForUnknownSource(
  current: string,
  variant: UpdateCheckVariant
): void {
  recordUpdaterLifecycle(
    'routine_check_skipped_unknown_source',
    { current, variant },
    {
      level: 'warn',
      message: `routine ${variant} check skipped: no configured release source owns ${current}`
    }
  )
}
