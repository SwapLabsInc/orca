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

/**
 * Why main decides the install mode: it is the verdict `downloadUpdate` and the pinned check
 * refuse by, so the button that names the action cannot promise one this host cannot make.
 */
export function resolveReleaseSourceInstallMode(
  source: ReleaseSource,
  runningSource: ReleaseSourceId | null
): ReleaseSourceInstallMode {
  if (process.platform === 'linux' && isExternallyManagedLinuxInstall()) {
    return 'externally-managed'
  }
  return requiresManualInstall({
    platform: process.platform,
    running: { source: runningSource, channel: getVersionChannel(app.getVersion()) },
    target: { source: source.id, channel: 'stable' }
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
  force: boolean
): Promise<ReleaseSourceStatus[]> {
  const runningSource = getVersionReleaseSource(app.getVersion())
  return Promise.all(
    RELEASE_SOURCES.map(async (source): Promise<ReleaseSourceStatus> => {
      const status = {
        id: source.id,
        label: source.label,
        running: source.id === runningSource,
        install: resolveReleaseSourceInstallMode(source, runningSource)
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
