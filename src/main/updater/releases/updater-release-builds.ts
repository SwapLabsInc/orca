import { net } from 'electron'
import {
  findInstallerAssetName,
  getReleaseRepoForChannel,
  getVersionChannel,
  hasInstallableArtifactForPlatform,
  normalizeTagToVersion,
  sortReleaseBuildsNewestFirst,
  type ReleaseBuild,
  type ReleaseChannel
} from '../../../shared/updater/release-channel'
import { parseRetryAfterHeaderMs } from '../../../shared/network/retry-after-header'
import {
  PRIMARY_RELEASE_SOURCE,
  getVersionReleaseSource,
  type ReleaseSource
} from '../../../shared/updater/release-sources'
import {
  getGhRateLimitBlockedUntilMs,
  recordGhPrimaryRateLimit
} from '../../git/command-runner/hosted-cli/gh-rate-limit-breaker'
import { isValidVersion } from './updater-fallback'
import { rejectReleaseApiToken, resolveReleaseApiToken } from './updater-release-api-token'
import { UpdaterCodedError } from '../lifecycle/updater-coded-error'
import { getReleaseDownloadUrlForRepo } from '../../updater-release-urls'
import { getMacSelfUpdateAssetNames } from '../../../shared/updater/mac-self-update-assets'
import { getMacSelfUpdateInstallerSourceFor } from '../mac-self-update/mac-self-update-activation'

export { getReleaseDownloadUrlForRepo }

const FETCH_TIMEOUT_MS = 8000
const MAX_LISTED_BUILDS = 100
// Each release carries full notes and ~30 assets (~65 KB), so delay lookups page small and stop early.
const DELAY_LOOKUP_PAGE_SIZE = 20
const RETRY_AFTER_MAX_MS = 60 * 60_000

type ReleasePage = { perPage: number; page: number }

function getReleasesApiUrl(repo: string, { perPage, page }: ReleasePage): string {
  return `https://api.github.com/repos/${repo}/releases?per_page=${perPage}&page=${page}`
}

function fetchReleases(repo: string, token: string | null, page: ReleasePage): Promise<Response> {
  const headers: Record<string, string> = { Accept: 'application/vnd.github+json' }
  if (token) {
    headers.Authorization = `Bearer ${token}`
  }
  return net.fetch(getReleasesApiUrl(repo, page), {
    headers,
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
  })
}

function isRateLimited(res: Response): boolean {
  return (
    res.status === 429 ||
    (res.status === 403 &&
      (res.headers.get('x-ratelimit-remaining') === '0' || res.headers.has('retry-after')))
  )
}

// Retry-After marks secondary limits: neither trip the primary breaker nor retry immediately.
function isPrimaryRateLimited(res: Response): boolean {
  return res.headers.get('x-ratelimit-remaining') === '0' && !res.headers.has('retry-after')
}

// Retry-After gives the requested wait; the primary reset can overstate a secondary throttle.
export function rateLimitResetAtMs(headers: Headers, nowMs: number): number | null {
  const retryAfterMs = parseRetryAfterHeaderMs(
    headers.get('retry-after'),
    RETRY_AFTER_MAX_MS,
    nowMs
  )
  if (retryAfterMs !== null) {
    return nowMs + retryAfterMs
  }
  const resetEpochSeconds = Number(headers.get('x-ratelimit-reset'))
  return resetEpochSeconds > 0 ? resetEpochSeconds * 1000 : null
}

function rateLimitError(resetAtMs: number | null, nowMs: number, signedIn: boolean): Error {
  if (resetAtMs === null) {
    return new UpdaterCodedError(signedIn ? 'rateLimitedSoon' : 'rateLimitedSoonSignedOut')
  }
  const minutes = Math.ceil((resetAtMs - nowMs) / 60_000)
  if (minutes <= 1) {
    return new UpdaterCodedError(signedIn ? 'rateLimitedInMinute' : 'rateLimitedInMinuteSignedOut')
  }
  return new UpdaterCodedError(
    signedIn ? 'rateLimitedInMinutes' : 'rateLimitedInMinutesSignedOut',
    { count: minutes }
  )
}

function releaseListError(
  res: Response,
  repo: string,
  channel: ReleaseChannel,
  signedIn: boolean
): Error {
  if (res.status === 404) {
    return new UpdaterCodedError('releaseRepoNotFound', { repo })
  }
  if (isRateLimited(res)) {
    const nowMs = Date.now()
    return rateLimitError(rateLimitResetAtMs(res.headers, nowMs), nowMs, signedIn)
  }
  return new UpdaterCodedError('releaseListFailed', { channel, status: res.status })
}

type GitHubReleaseEntry = {
  tag_name?: unknown
  name?: unknown
  draft?: unknown
  published_at?: unknown
  html_url?: unknown
  assets?: unknown
}

function readAssetNames(assets: unknown): string[] {
  if (!Array.isArray(assets)) {
    return []
  }
  return assets
    .map((asset) => (asset as { name?: unknown })?.name)
    .filter((name): name is string => typeof name === 'string')
}

/**
 * The version a release publishes for `source`. Primary tags are `v<version>`;
 * other sources tag by git label, so the version is read from the title instead.
 * A version that belongs to a different source is not this source's build.
 */
function resolveReleaseVersion(tag: string, name: string, source: ReleaseSource): string | null {
  const isSourceVersion = (candidate: string): boolean =>
    isValidVersion(candidate) && getVersionReleaseSource(candidate) === source.id
  const tagVersion = normalizeTagToVersion(tag)
  if (isSourceVersion(tagVersion)) {
    return tagVersion
  }
  if (source.prereleaseIdentifier === null) {
    return null
  }
  return (
    name
      .split(/[\s•]+/)
      .map(normalizeTagToVersion)
      .find(isSourceVersion) ?? null
  )
}

/**
 * LOCAL: on a build Orca's own installer updates, a release is installable once this slice's zip,
 * signed manifest and signature are all attached: the installer fetches each and nothing else, so
 * a release caught between uploads (or carrying only a DMG or a stray `latest-mac.yml`) would
 * fail on selection. A non-primary source's macOS release the installer does not apply to (a
 * build that can only install by hand, or another source's release) is installed by hand from
 * its DMG, and it publishes no `latest-mac.yml` that the platform rule could read. Everywhere
 * else the platform's electron-updater manifest decides.
 */
function hasInstallableArtifact(
  assetNames: readonly string[],
  platform: NodeJS.Platform,
  arch: NodeJS.Architecture,
  source: ReleaseSource,
  macSelfUpdateSource: ReleaseSource | null
): boolean {
  if (macSelfUpdateSource !== null) {
    return getMacSelfUpdateAssetNames(macSelfUpdateSource, arch).every((name) =>
      assetNames.includes(name)
    )
  }
  if (platform === 'darwin' && source.prereleaseIdentifier !== null) {
    return findInstallerAssetName(platform, assetNames, arch) !== null
  }
  return hasInstallableArtifactForPlatform(platform, assetNames)
}

function parseReleaseEntry(
  entry: GitHubReleaseEntry,
  repo: string,
  platform: NodeJS.Platform,
  arch: NodeJS.Architecture,
  source: ReleaseSource,
  macSelfUpdateSource: ReleaseSource | null
): ReleaseBuild | null {
  if (typeof entry.tag_name !== 'string' || entry.draft === true) {
    return null
  }
  const tag = entry.tag_name
  const name = typeof entry.name === 'string' ? entry.name.trim() : ''
  const version = resolveReleaseVersion(tag, name, source)
  const channel = version ? getVersionChannel(version) : null
  if (!version || !channel) {
    return null
  }
  // Platform release legs publish independently; offer only artifacts that actually exist.
  const assetNames = readAssetNames(entry.assets)
  if (!hasInstallableArtifact(assetNames, platform, arch, source, macSelfUpdateSource)) {
    return null
  }
  // Why by arch: the picker's download is installed by hand, so it must be the running slice.
  const installerAsset = findInstallerAssetName(platform, assetNames, arch)
  return {
    tag,
    version,
    channel,
    name: name && name !== tag ? name : null,
    publishedAt: typeof entry.published_at === 'string' ? entry.published_at : null,
    releaseUrl:
      typeof entry.html_url === 'string'
        ? entry.html_url
        : `https://github.com/${repo}/releases/tag/${encodeURIComponent(tag)}`,
    installerUrl: installerAsset
      ? `${getReleaseDownloadUrlForRepo(repo, tag)}/${encodeURIComponent(installerAsset)}`
      : null
  }
}

/** LOCAL: the release source a listing reads, and the installer source that decides what is installable. */
type ReleaseListingScope = {
  source: ReleaseSource
  arch: NodeJS.Architecture
  installerSource: ReleaseSource | null
}

async function resolveReleaseListingScope(
  source: ReleaseSource,
  arch: NodeJS.Architecture,
  macSelfUpdateSource?: ReleaseSource | null
): Promise<ReleaseListingScope> {
  const installerSource =
    macSelfUpdateSource === undefined
      ? await getMacSelfUpdateInstallerSourceFor(source)
      : macSelfUpdateSource
  return { source, arch, installerSource }
}

// REST exposes older builds the short Atom feed omits; use only for explicit picker requests and update-delay gaps.
async function fetchReleaseBuildsPage(
  channel: ReleaseChannel,
  platform: NodeJS.Platform,
  page: ReleasePage,
  { source, arch, installerSource }: ReleaseListingScope
): Promise<{ builds: ReleaseBuild[]; isLastPage: boolean }> {
  const repo = getReleaseRepoForChannel(channel, source.id)
  // Skip a known-exhausted token bucket and try the separate per-IP quota.
  const credential = await resolveReleaseApiToken()
  const tokenBucketBlocked =
    credential !== null &&
    getGhRateLimitBlockedUntilMs('core', Date.now(), credential.rateLimitScope) !== null
  const token = tokenBucketBlocked ? null : (credential?.token ?? null)
  let signedIn = credential !== null
  let res = await fetchReleases(repo, token, page)
  if (token && res.status === 401) {
    // A rejected token must not prevent listing a public repo unauthenticated.
    rejectReleaseApiToken()
    signedIn = false
    res = await fetchReleases(repo, null, page)
  } else if (token && isRateLimited(res) && isPrimaryRateLimited(res)) {
    // The per-IP quota may still be available; mark the token bucket spent before retrying.
    const resetAtMs = rateLimitResetAtMs(res.headers, Date.now())
    if (resetAtMs !== null && credential) {
      recordGhPrimaryRateLimit('core', resetAtMs, credential.rateLimitScope)
    }
    res = await fetchReleases(repo, null, page)
  }
  if (!res.ok) {
    throw releaseListError(res, repo, channel, signedIn)
  }
  const payload: unknown = await res.json()
  if (!Array.isArray(payload)) {
    throw new UpdaterCodedError('releaseListUnreadable', { channel })
  }
  const builds = payload
    .map((entry: GitHubReleaseEntry) =>
      parseReleaseEntry(entry, repo, platform, arch, source, installerSource)
    )
    .filter((build): build is ReleaseBuild => build !== null)
  return { builds, isLastPage: payload.length < page.perPage }
}

export async function listReleaseBuilds(
  channel: ReleaseChannel,
  platform: NodeJS.Platform = process.platform,
  source: ReleaseSource = PRIMARY_RELEASE_SOURCE,
  arch: NodeJS.Architecture = process.arch,
  /** LOCAL: the source whose releases Orca's own installer lists by its own assets; resolved from the running build when omitted. */
  macSelfUpdateSource?: ReleaseSource | null
): Promise<ReleaseBuild[]> {
  const { builds } = await fetchReleaseBuildsPage(
    channel,
    platform,
    { perPage: MAX_LISTED_BUILDS, page: 1 },
    await resolveReleaseListingScope(source, arch, macSelfUpdateSource)
  )
  return sortReleaseBuildsNewestFirst(builds.filter((build) => build.channel === channel))
}

/** Main-repo (stable and rc) builds, newest first, paged until `hasEnough` or the picker's reach. */
export async function listMainRepoReleaseBuildsUntil(
  hasEnough: (builds: ReleaseBuild[]) => boolean,
  platform: NodeJS.Platform = process.platform
): Promise<ReleaseBuild[]> {
  const scope = await resolveReleaseListingScope(PRIMARY_RELEASE_SOURCE, process.arch)
  const builds: ReleaseBuild[] = []
  for (let page = 1; page * DELAY_LOOKUP_PAGE_SIZE <= MAX_LISTED_BUILDS; page++) {
    const result = await fetchReleaseBuildsPage(
      'stable',
      platform,
      { perPage: DELAY_LOOKUP_PAGE_SIZE, page },
      scope
    )
    builds.push(...result.builds)
    if (result.isLastPage || hasEnough(builds)) {
      break
    }
  }
  return builds
}

export type ResolvedTargetBuild = {
  tag: string
  version: string
  /** The repo the feed reads: a dev channel's own, not the source's main one. */
  repo: string
  feedUrl: string
}

/**
 * Resolves a tag the user picked into a pinned generic feed URL. Non-primary
 * sources tag by git label, so the picker passes the version it listed; the
 * primary's tags carry it.
 */
export function resolveTargetBuild(
  channel: ReleaseChannel,
  tag: string,
  source: ReleaseSource = PRIMARY_RELEASE_SOURCE,
  knownVersion: string | null = null
): ResolvedTargetBuild {
  const version = knownVersion ?? normalizeTagToVersion(tag)
  if (!isValidVersion(version) || getVersionReleaseSource(version) !== source.id) {
    throw source.prereleaseIdentifier === null
      ? new UpdaterCodedError('invalidReleaseTag', { tag })
      : new Error(`"${tag}" is not a valid release tag for ${source.label}.`)
  }
  const repo = getReleaseRepoForChannel(channel, source.id)
  return { tag, version, repo, feedUrl: getReleaseDownloadUrlForRepo(repo, tag) }
}
