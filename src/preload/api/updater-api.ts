import type {
  LinuxPackageInstallInstructions,
  ReleaseBuildListResult,
  ReleaseSourceStatus,
  UpdateCheckOptions,
  UpdateStatus
} from '../../shared/update-status-types'
import type { ReleaseChannel } from '../../shared/release-channel'
import type { ReleaseSourceId } from '../../shared/release-sources'

export type UpdaterApi = {
  getVersion: () => Promise<string>
  getStatus: () => Promise<UpdateStatus>
  check: (options?: UpdateCheckOptions) => Promise<void>
  download: () => Promise<void>
  quitAndInstall: () => Promise<void>
  dismissNudge: () => Promise<void>
  dismissAvailableUpdate: () => Promise<void>
  /** Desktop-only. Rejects unless the current status carries `linux-package-install` recovery. */
  getLinuxPackageInstallInstructions: () => Promise<LinuxPackageInstallInstructions>
  /** Desktop-only. Reveals the revalidated cached package in the native file manager. */
  showLinuxPackage: () => Promise<void>
  /** `force` bypasses the main-process list cache — the refresh button, not mount or channel switches.
   *  `source` lists another configured release source; absent means the primary. */
  listBuilds: (
    channel: ReleaseChannel,
    options?: { force?: boolean; source?: ReleaseSourceId }
  ) => Promise<ReleaseBuildListResult>
  /** Desktop-only. Every configured release source with its newest build; `force` bypasses the
   *  main-process list cache, as a "Check for updates" click should. */
  listSources: (options?: { force?: boolean }) => Promise<ReleaseSourceStatus[]>

  onStatus: (callback: (status: UpdateStatus) => void) => () => void
  onClearDismissal: (callback: () => void) => () => void
}
