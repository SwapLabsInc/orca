import { compareAppVersions, isValidAppVersion } from './app-version'
import {
  PRIMARY_RELEASE_SOURCE,
  getReleaseSourceOrPrimary,
  getReleaseSourceVersionPattern,
  getVersionReleaseSource,
  type ReleaseSourceId
} from './release-sources'

export type ReleaseChannel = 'stable' | 'rc' | 'hourly' | 'daily' | 'adhoc'

export const RELEASE_CHANNELS: readonly ReleaseChannel[] = [
  'stable',
  'rc',
  'hourly',
  'daily',
  'adhoc'
]

export const RELEASE_CHANNEL_LABELS: Readonly<Record<ReleaseChannel, string>> = {
  stable: 'Stable',
  rc: 'RC',
  hourly: 'Hourly',
  daily: 'Daily',
  adhoc: 'Adhoc'
}

/** Dev builds live in their own repos so their tags never enter the main
 *  releases atom feed, which only exposes the 10 newest entries — 24 hourly
 *  tags a day would evict every stable/RC entry and strand real users. */
export const HOURLY_RELEASE_REPO = 'stablyai/orca-hourly'
export const DAILY_RELEASE_REPO = 'stablyai/orca-daily'
export const ADHOC_RELEASE_REPO = 'stablyai/orca-adhoc'
/** The primary release source's repo; a fork build's own source is looked up per version instead. */
export const MAIN_RELEASE_REPO = PRIMARY_RELEASE_SOURCE.repo

export const HOURLY_PRERELEASE_IDENTIFIER = 'hourly'
export const DAILY_PRERELEASE_IDENTIFIER = 'daily'
export const ADHOC_PRERELEASE_IDENTIFIER = 'adhoc'

/** The dev channels, each published to its own repo rather than the main one. */
const DEDICATED_REPO_CHANNELS = ['hourly', 'daily', 'adhoc'] as const

export type DedicatedRepoChannel = (typeof DEDICATED_REPO_CHANNELS)[number]

const CHANNEL_RELEASE_REPOS: Record<ReleaseChannel, string> = {
  stable: MAIN_RELEASE_REPO,
  rc: MAIN_RELEASE_REPO,
  hourly: HOURLY_RELEASE_REPO,
  daily: DAILY_RELEASE_REPO,
  adhoc: ADHOC_RELEASE_REPO
}

export function isReleaseChannel(value: unknown): value is ReleaseChannel {
  return typeof value === 'string' && RELEASE_CHANNELS.includes(value as ReleaseChannel)
}

/** True for channels published outside the main repo. The updater reports these
 *  as a distinct source so a pinned dev build is never mistaken for a release. */
export function hasDedicatedReleaseRepo(channel: ReleaseChannel): channel is DedicatedRepoChannel {
  return (DEDICATED_REPO_CHANNELS as readonly ReleaseChannel[]).includes(channel)
}

/**
 * The platforms each dev channel actually builds for. Split from
 * `hasDedicatedReleaseRepo` because "published to its own repo" and "built for
 * this OS" stopped coinciding once the dev workflows gained a Windows job —
 * Linux has no dev-channel artifact yet, so it still falls back to stable/RC.
 */
const DEV_CHANNEL_PLATFORMS: Readonly<Record<DedicatedRepoChannel, readonly NodeJS.Platform[]>> = {
  hourly: ['darwin', 'win32'],
  daily: ['darwin', 'win32'],
  adhoc: ['darwin', 'win32']
}

/** Human-readable list of where dev builds exist, for picker copy that would
 *  otherwise have to restate the table above and drift from it. */
export const DEV_CHANNEL_PLATFORM_LABEL = 'macOS and Windows'

/**
 * Shared so the picker, the main-process check, and any future surface cannot
 * drift on where a channel is available.
 */
export function isChannelSupportedOnPlatform(
  channel: ReleaseChannel,
  platform: NodeJS.Platform
): boolean {
  if (!hasDedicatedReleaseRepo(channel)) {
    return true
  }
  return DEV_CHANNEL_PLATFORMS[channel].includes(platform)
}

/**
 * True when the running build cannot reach `targetChannel` through the in-app
 * updater and the installer has to be run by hand instead.
 *
 * Windows dev builds ship unsigned, because SignPath's approval waits are
 * budgeted in hours and cannot fit an hourly cadence. electron-updater
 * Authenticode-verifies every installer it downloads against the publisherName
 * baked into the *installed* app's app-update.yml, so a signed stable or RC
 * rejects an unsigned dev installer outright with ERR_UPDATER_INVALID_SIGNATURE
 * — and no change to a future build can fix the copies already installed.
 *
 * Dev builds omit that name, so verification is skipped there and every route
 * *out* of a dev channel, including back to stable, still works in-app. Only
 * the way in is blocked, and only on Windows.
 *
 * A null `runningChannel` (an unparseable version) is treated as signed: the
 * conservative answer sends someone to a working download rather than to an
 * update that fails with a signature error.
 */
export function requiresManualDevChannelInstall(options: {
  platform: NodeJS.Platform
  runningChannel: ReleaseChannel | null
  targetChannel: ReleaseChannel
}): boolean {
  const { platform, runningChannel, targetChannel } = options
  if (platform !== 'win32' || !hasDedicatedReleaseRepo(targetChannel)) {
    return false
  }
  return runningChannel === null || !hasDedicatedReleaseRepo(runningChannel)
}

/**
 * The repo that publishes `channel` for `source`. Dev channels hang off the
 * primary source only; every other source is one series in one repo.
 */
export function getReleaseRepoForChannel(
  channel: ReleaseChannel,
  sourceId: ReleaseSourceId | null = null
): string {
  const source = getReleaseSourceOrPrimary(sourceId)
  if (source.id === PRIMARY_RELEASE_SOURCE.id) {
    return CHANNEL_RELEASE_REPOS[channel]
  }
  return source.repo
}

/**
 * Whether a jump has to go through a downloaded installer rather than the
 * in-app updater. macOS and Windows refuse every cross-source jump: Squirrel.Mac
 * only installs a bundle carrying the running app's code signature, and on
 * Windows electron-updater Authenticode-verifies each installer against the
 * publisherName baked into the installed app — and each source signs (or ad-hoc
 * signs) with its own identity. Windows also keeps the dev-channel signing rule
 * above. Linux never needs one; deb/rpm are refused later as externally managed.
 * A null running source (unparseable version) counts as a different one, which
 * sends the user to a download that works.
 */
export function requiresManualInstall(options: {
  platform: NodeJS.Platform
  running: { source: ReleaseSourceId | null; channel: ReleaseChannel | null }
  target: { source: ReleaseSourceId; channel: ReleaseChannel }
}): boolean {
  const { platform, running, target } = options
  if ((platform === 'darwin' || platform === 'win32') && running.source !== target.source) {
    return true
  }
  return requiresManualDevChannelInstall({
    platform,
    runningChannel: running.channel,
    targetChannel: target.channel
  })
}

export function normalizeTagToVersion(tag: string): string {
  return tag.replace(/^v/i, '')
}

/** `1.4.160-hourly.202607281400` — a timestamp identifier keeps every build
 *  uniquely versioned so electron-updater never reads one as "same version". */
const HOURLY_VERSION = /^\d+\.\d+\.\d+-hourly\.(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})$/

/** `1.4.160-daily.202607281415` — same minute stamp as hourly. Daily cuts once
 *  per day, so collisions are not a concern; the stamp still carries the hour so
 *  a forced re-cut the same calendar day remains unique. */
const DAILY_VERSION = /^\d+\.\d+\.\d+-daily\.(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})$/

/**
 * `1.4.160-adhoc.20260728140533` — same idea, but stamped to the second.
 *
 * Why seconds here and not for hourly/daily: those run under a concurrency
 * group, so two of them can never be cut in the same minute. Adhoc builds are
 * dispatched on demand by whoever wants one, so two people cutting from
 * different branches at once is ordinary — and a minute-resolution stamp would
 * collide on the tag and fail the second build eight minutes in.
 */
const ADHOC_VERSION = /^\d+\.\d+\.\d+-adhoc\.(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/

/**
 * Both patterns are anchored on the whole version: an unanchored tail match also
 * accepts garbage prefixes, so `not-a-version-hourly.202601010000` would parse.
 */
function parseStampedVersion(version: string, pattern: RegExp): Date | null {
  const match = normalizeTagToVersion(version).match(pattern)
  if (!match) {
    return null
  }
  const [year, month, day, hour, minute, second = 0] = match.slice(1).map(Number)
  const parsed = new Date(Date.UTC(year, month - 1, day, hour, minute, second))
  // Why the round-trip: Date.UTC silently rolls impossible dates forward, so a
  // corrupt `...hourly.202602300000` would render as March 2 rather than fail.
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day ||
    parsed.getUTCHours() !== hour ||
    parsed.getUTCMinutes() !== minute ||
    parsed.getUTCSeconds() !== second
  ) {
    return null
  }
  return parsed
}

export function isHourlyVersion(version: string): boolean {
  return HOURLY_VERSION.test(normalizeTagToVersion(version))
}

export function isDailyVersion(version: string): boolean {
  return DAILY_VERSION.test(normalizeTagToVersion(version))
}

export function isAdhocVersion(version: string): boolean {
  return ADHOC_VERSION.test(normalizeTagToVersion(version))
}

export function formatHourlyVersion(baseVersion: string, stamp: string): string {
  return `${baseVersion}-${HOURLY_PRERELEASE_IDENTIFIER}.${stamp}`
}

export function formatDailyVersion(baseVersion: string, stamp: string): string {
  return `${baseVersion}-${DAILY_PRERELEASE_IDENTIFIER}.${stamp}`
}

export function formatAdhocVersion(baseVersion: string, stamp: string): string {
  return `${baseVersion}-${ADHOC_PRERELEASE_IDENTIFIER}.${stamp}`
}

/** Returns the build's UTC timestamp, or null when the version isn't hourly. */
export function parseHourlyVersionStamp(version: string): Date | null {
  return parseStampedVersion(version, HOURLY_VERSION)
}

/** Returns the build's UTC timestamp, or null when the version isn't daily. */
export function parseDailyVersionStamp(version: string): Date | null {
  return parseStampedVersion(version, DAILY_VERSION)
}

/** Returns the build's UTC timestamp, or null when the version isn't adhoc. */
export function parseAdhocVersionStamp(version: string): Date | null {
  return parseStampedVersion(version, ADHOC_VERSION)
}

/** The build's UTC timestamp for any dev channel, so a picker row can render a
 *  date without first working out which channel produced the version. */
export function parseDevBuildStamp(version: string): Date | null {
  return (
    parseHourlyVersionStamp(version) ??
    parseDailyVersionStamp(version) ??
    parseAdhocVersionStamp(version)
  )
}

/** The minute stamp of a non-primary source build (`1.4.197-swaplabs.202609241530`), else null. */
export function parseSourceBuildStamp(version: string): Date | null {
  const sourceId = getVersionReleaseSource(version)
  const pattern = sourceId
    ? getReleaseSourceVersionPattern(getReleaseSourceOrPrimary(sourceId))
    : null
  return pattern ? parseStampedVersion(version, pattern) : null
}

/** Cut time of any stamped build — dev channel or source series — for ordering. */
export function parseReleaseBuildStamp(version: string): Date | null {
  return parseDevBuildStamp(version) ?? parseSourceBuildStamp(version)
}

export function getVersionChannel(version: string): ReleaseChannel | null {
  const normalized = normalizeTagToVersion(version)
  if (!isValidAppVersion(normalized)) {
    return null
  }
  // Why: a non-primary source is one series with no rc/stable split, and its
  // versions are prereleases that the catch-all below would otherwise file under rc.
  const sourceId = getVersionReleaseSource(normalized)
  if (sourceId !== null && sourceId !== PRIMARY_RELEASE_SOURCE.id) {
    return 'stable'
  }
  if (isHourlyVersion(normalized)) {
    return 'hourly'
  }
  if (isDailyVersion(normalized)) {
    return 'daily'
  }
  if (isAdhocVersion(normalized)) {
    return 'adhoc'
  }
  // Why the dev channels are tested first: they are prereleases too, so this
  // catch-all would otherwise file every one of them under rc.
  return normalized.includes('-') ? 'rc' : 'stable'
}

/**
 * Release-notes page for a version, in whichever repo published it. Dev-channel
 * tags exist only in their own repo, so a main-repo tag URL for one 404s.
 * A null version falls back to the plain releases listing (not /releases/latest
 * — /latest also breaks when GitHub's API is degraded).
 */
export function getReleaseNotesUrlForVersion(version: string | null): string {
  const sourceId = version ? getVersionReleaseSource(version) : null
  const channel = version ? getVersionChannel(version) : null
  const repo = channel ? getReleaseRepoForChannel(channel, sourceId) : MAIN_RELEASE_REPO
  // Why the listing for other sources: their tags are not `v<version>`, so a tag URL cannot be derived.
  return version && (sourceId === null || sourceId === PRIMARY_RELEASE_SOURCE.id)
    ? `https://github.com/${repo}/releases/tag/v${normalizeTagToVersion(version)}`
    : `https://github.com/${repo}/releases`
}

/** The slices the Linux release legs build; each publishes its own manifest and AppImage. */
const LINUX_RELEASE_ARCHITECTURES: readonly NodeJS.Architecture[] = ['x64', 'arm64']

/**
 * The electron-updater manifest each platform's updater fetches before it can
 * install anything. A release without one has nothing that platform can use,
 * which is how a build whose Windows leg failed — or one whose Windows leg is
 * still running — stays out of that platform's picker instead of becoming a row
 * that 404s on download.
 */
const PLATFORM_UPDATE_MANIFESTS: Partial<Record<NodeJS.Platform, readonly string[]>> = {
  darwin: ['latest-mac.yml'],
  win32: ['latest.yml'],
  // Both, because one release carries x64 and arm64 and either makes it installable.
  linux: LINUX_RELEASE_ARCHITECTURES.map((arch) => getUpdateManifestName('linux', arch))
}

/**
 * The manifest the updater running on one slice fetches. electron-builder suffixes
 * only Linux manifests by architecture, and only off x64 (`latest-linux-arm64.yml`);
 * macOS and Windows list every slice in one file.
 */
export function getUpdateManifestName(
  platform: NodeJS.Platform,
  arch: NodeJS.Architecture
): string {
  if (platform === 'darwin') {
    return 'latest-mac.yml'
  }
  if (platform === 'linux') {
    return arch === 'x64' ? 'latest-linux.yml' : `latest-linux-${arch}.yml`
  }
  return 'latest.yml'
}

export function getUpdateManifestNamesForPlatform(platform: NodeJS.Platform): readonly string[] {
  return PLATFORM_UPDATE_MANIFESTS[platform] ?? []
}

/** True when the release carries an artifact this platform's updater can install. */
export function hasInstallableArtifactForPlatform(
  platform: NodeJS.Platform,
  assetNames: readonly string[]
): boolean {
  const manifests = getUpdateManifestNamesForPlatform(platform)
  // Why permissive on an unknown platform: a filter that hides every build is a
  // worse failure than one that offers a build the download step will report on.
  if (manifests.length === 0) {
    return true
  }
  return manifests.some((manifest) => assetNames.includes(manifest))
}

/** Matches the electron-builder `artifactName` for each platform's directly
 *  runnable installer — the file someone downloads when the in-app updater
 *  cannot make the jump. macOS and Linux publish one per slice
 *  (`orca-macos-<arch>.dmg`; `orca-linux.AppImage` and `orca-linux-arm64.AppImage`),
 *  so theirs are picked by architecture. */
const PLATFORM_INSTALLER_PATTERNS: Partial<Record<NodeJS.Platform, RegExp>> = {
  win32: /windows-setup\.exe$/i
}

const SLICE_INSTALLER_PATTERNS: Partial<
  Record<NodeJS.Platform, Partial<Record<NodeJS.Architecture, RegExp>>>
> = {
  darwin: { arm64: /-arm64\.dmg$/i, x64: /-x64\.dmg$/i },
  // Why the lookbehind: the x64 AppImage carries no arch suffix, so it is any AppImage but the arm64 one.
  linux: { arm64: /-arm64\.AppImage$/i, x64: /(?<!-arm64)\.AppImage$/i }
}

export function findInstallerAssetName(
  platform: NodeJS.Platform,
  assetNames: readonly string[],
  arch: NodeJS.Architecture
): string | null {
  const slicePatterns = SLICE_INSTALLER_PATTERNS[platform]
  const pattern = slicePatterns ? slicePatterns[arch] : PLATFORM_INSTALLER_PATTERNS[platform]
  if (!pattern) {
    return null
  }
  return assetNames.find((name) => pattern.test(name)) ?? null
}

export type ReleaseBuild = {
  tag: string
  version: string
  channel: ReleaseChannel
  /** The release's GitHub title. Null when it is absent or just repeats the tag,
   *  so the picker can tell "the workflow named this" from "nobody did". */
  name: string | null
  publishedAt: string | null
  releaseUrl: string
  /** Direct download for this platform's installer, or null when the release
   *  published none. Drives the Windows bootstrap path, where a signed build
   *  cannot reach a dev channel through the updater. */
  installerUrl: string | null
}

/** Newest first, so the picker's first row is always the channel's current tip. */
export function sortReleaseBuildsNewestFirst(builds: ReleaseBuild[]): ReleaseBuild[] {
  return [...builds].sort((left, right) => {
    // Dev build base versions can move backwards when a branch was cut before
    // the latest main build. Their stamped build time, not semver, is the
    // meaningful "newest" signal for the picker.
    const leftStamp = parseReleaseBuildStamp(left.version)?.getTime() ?? null
    const rightStamp = parseReleaseBuildStamp(right.version)?.getTime() ?? null
    if (leftStamp !== null && rightStamp !== null && leftStamp !== rightStamp) {
      return rightStamp - leftStamp
    }

    if (hasDedicatedReleaseRepo(left.channel) && hasDedicatedReleaseRepo(right.channel)) {
      const leftPublished = left.publishedAt ? Date.parse(left.publishedAt) : Number.NaN
      const rightPublished = right.publishedAt ? Date.parse(right.publishedAt) : Number.NaN
      if (
        Number.isFinite(leftPublished) &&
        Number.isFinite(rightPublished) &&
        leftPublished !== rightPublished
      ) {
        return rightPublished - leftPublished
      }
    }

    return compareAppVersions(right.version, left.version)
  })
}
