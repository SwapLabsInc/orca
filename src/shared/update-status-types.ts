import type { DedicatedRepoChannel, ReleaseBuild, ReleaseChannel } from './release-channel'
import type { ReleaseSourceId } from './release-sources'

// ─── Updater ─────────────────────────────────────────────────────────

// Why: the release object sent to the renderer omits `version` (redundant
// with the top-level UpdateStatus.version) to keep one source of truth.
export type ChangelogRelease = {
  title: string
  description: string
  mediaUrl?: string
  releaseNotesUrl: string
}

export type ChangelogData = {
  release: ChangelogRelease
  releasesBehind: number | null
}

export type UpdateCheckOptions = {
  includePrerelease?: boolean
  includePerfPrerelease?: boolean
  localBuild?: boolean
  /** Dev channel switching; `targetTag` pins an exact build, including older ones. */
  channel?: ReleaseChannel
  targetTag?: string
  /**
   * Cross-source install: the release source `targetTag` lives in. Absent means the
   * running build's own source. Non-primary tags do not carry the version, so the
   * caller passes the one it listed in `targetVersion`.
   */
  source?: ReleaseSourceId
  targetVersion?: string
  /** Start the download as soon as the pinned build reports available. */
  autoDownload?: boolean
}

/** Non-release origins for an update. Derived from the dev-channel list so a new
 *  channel with its own repo cannot be reported as an ordinary release. */
export type UpdateSource = 'local' | DedicatedRepoChannel

/** Root-package Linux install formats whose update installs need privilege escalation. */
export type LinuxRootPackageType = 'deb' | 'rpm'

export type LinuxPackageInstallFailureReason =
  | 'authentication-agent-unavailable'
  | 'authentication-denied'
  | 'package-install-failed'

export type LinuxPackageInstallRecoveryReason =
  | 'manual-install-required'
  | LinuxPackageInstallFailureReason

// Older paired hosts can still publish classified install failures; the manual reason is additive.
export type LinuxPackageInstallRecovery = {
  kind: 'linux-package-install'
  packageType: LinuxRootPackageType
  reason: LinuxPackageInstallRecoveryReason
  version: string
}

/** Why: only these two mean no safe command exists here; every other failure clears recovery entirely. */
export type LinuxPackageCommandUnavailableReason = 'no-sudo' | 'no-package-manager'

export type LinuxPackageInstallInstructions =
  | { ok: true; command: string; packageFileName: string }
  | { ok: false; reason: LinuxPackageCommandUnavailableReason; message: string }

export type UpdateStatus = (
  | { state: 'idle' }
  | { state: 'checking'; userInitiated?: boolean }
  | {
      state: 'available'
      version: string
      activeNudgeId?: string
      // Why: releaseUrl is not currently populated by the update-available handler
      // (it always sends undefined). Kept on the type for the Settings page's
      // release-notes link fallback and for potential future use if the main
      // process starts extracting release URLs from electron-updater metadata.
      releaseUrl?: string
      // Why: changelog is always explicitly set by the main process — null means
      // the fetch failed or the version wasn't in the JSON (simple mode), and a
      // populated object means rich mode. Using `| null` (not `?`) avoids a
      // three-state ambiguity (undefined vs null vs present) and makes exhaustive
      // checks straightforward.
      changelog: ChangelogData | null
      /** Linux only: a package manager owns this install, so Orca cannot apply the update itself.
       *  Additive and optional — older clients simply keep offering their own download. */
      externallyManaged?: boolean
    }
  | { state: 'not-available'; userInitiated?: boolean }
  | { state: 'downloading'; percent: number; version: string; activeNudgeId?: string }
  | { state: 'downloaded'; version: string; releaseUrl?: string; activeNudgeId?: string }
  | {
      state: 'error'
      message: string
      /** Known download/install target; absent for check-time failures and older hosts. */
      version?: string
      /** Omitted by older hosts and for failures whose retryability is unknown. */
      retryable?: boolean
      userInitiated?: boolean
      activeNudgeId?: string
      recovery?: LinuxPackageInstallRecovery
      /** Where to fetch the refused build by hand: a cross-source jump the in-app updater cannot make. */
      manualInstallUrl?: string
    }
) & {
  source?: UpdateSource
  /**
   * The release source the status refers to. Only multi-source builds set it, and
   * only for actionable states or a check against another source; absent means the
   * running build's own source — never a specific one (remote wire rule 1).
   */
  releaseSource?: ReleaseSourceId
}

export type ReleaseBuildListResult =
  | { ok: true; channel: ReleaseChannel; builds: ReleaseBuild[] }
  | { ok: false; channel: ReleaseChannel; message: string }

/**
 * How this install can move to a build of one release source. `in-app` runs the
 * updater; `manual-installer` means the running build's signature check would
 * refuse the download (a cross-source jump on macOS or Windows); `externally-managed`
 * means a Linux package manager owns this copy and Orca never installs anything.
 */
export type ReleaseSourceInstallMode = 'in-app' | 'manual-installer' | 'externally-managed'

/** One configured release source and its newest published build for this platform.
 *  Desktop-only (`updater:listSources`); never crosses the runtime wire. */
export type ReleaseSourceStatus = {
  id: ReleaseSourceId
  label: string
  /** True for the source the running build was published from. */
  running: boolean
  install: ReleaseSourceInstallMode
  /** Newest build carrying an installable artifact for this platform, or null when none is listed. */
  latest: ReleaseBuild | null
  /** Why `latest` is null when the list failed, returned as data so the row can show it. */
  error: string | null
}
