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
} from '../shared/release-channel'
import { parseRelayRetryAfterMs } from '../shared/relay-retry-after-header'
import {
  PRIMARY_RELEASE_SOURCE,
  getVersionReleaseSource,
  type ReleaseSource
} from '../shared/release-sources'
import { getGhRateLimitBlockedUntilMs, recordGhPrimaryRateLimit } from './git/gh-rate-limit-breaker'
import { isValidVersion } from './updater-fallback'
import { rejectReleaseApiToken, resolveReleaseApiToken } from './updater-release-api-token'
import { getReleaseDownloadUrlForRepo } from './updater-release-urls'

export { getReleaseDownloadUrlForRepo }

const FETCH_TIMEOUT_MS = 8000
const MAX_LISTED_BUILDS = 100
const RETRY_AFTER_MAX_MS = 60 * 60_000

function getReleasesApiUrl(repo: string): string {
  return `https://api.github.com/repos/${repo}/releases?per_page=${MAX_LISTED_BUILDS}`
}

function fetchReleases(repo: string, token: string | null): Promise<Response> {
  const headers: Record<string, string> = { Accept: 'application/vnd.github+json' }
  if (token) {
    headers.Authorization = `Bearer ${token}`
  }
  return net.fetch(getReleasesApiUrl(repo), {
    headers,
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
  })
}

/** GitHub answers a spent primary bucket with 403 + `x-ratelimit-remaining: 0`; secondary limits carry Retry-After. */
function isRateLimited(res: Response): boolean {
  return (
    res.status === 429 ||
    (res.status === 403 &&
      (res.headers.get('x-ratelimit-remaining') === '0' || res.headers.has('retry-after')))
  )
}

/**
 * Only a spent primary bucket may trip the shared gh breaker or be retried at once.
 * GitHub also sends `x-ratelimit-remaining: 0` on some secondary 403/429s, and those
 * carry Retry-After: blocking every core gh command until the primary reset would be
 * far wider than the limit GitHub actually applied, and Retry-After forbids any retry
 * before it elapses — an immediate unauthenticated one included, since GitHub may ban
 * an integration that keeps calling while throttled.
 */
function isPrimaryRateLimited(res: Response): boolean {
  return res.headers.get('x-ratelimit-remaining') === '0' && !res.headers.has('retry-after')
}

/**
 * Retry-After wins when GitHub sends it: it is the bounded wait the server actually
 * asked for, while `x-ratelimit-reset` describes the primary window and can be an hour
 * out — quoting that for a 90-second secondary throttle overstates the wait to the user.
 * Retry-After arrives as seconds or an HTTP date; the reset epoch is the fallback.
 */
export function rateLimitResetAtMs(headers: Headers, nowMs: number): number | null {
  const retryAfterMs = parseRelayRetryAfterMs(headers.get('retry-after'), RETRY_AFTER_MAX_MS, nowMs)
  if (retryAfterMs !== null) {
    return nowMs + retryAfterMs
  }
  const resetEpochSeconds = Number(headers.get('x-ratelimit-reset'))
  return resetEpochSeconds > 0 ? resetEpochSeconds * 1000 : null
}

export function describeRateLimitReset(resetAtMs: number | null, nowMs: number): string {
  if (resetAtMs === null) {
    return 'in a few minutes'
  }
  const minutes = Math.ceil((resetAtMs - nowMs) / 60_000)
  return minutes <= 1 ? 'in about a minute' : `in about ${minutes} minutes`
}

function releaseListError(
  res: Response,
  repo: string,
  channel: ReleaseChannel,
  signedIn: boolean
): Error {
  if (res.status === 404) {
    return new Error(`No releases repository found at ${repo}.`)
  }
  if (isRateLimited(res)) {
    const nowMs = Date.now()
    const retry = describeRateLimitReset(rateLimitResetAtMs(res.headers, nowMs), nowMs)
    return new Error(
      signedIn
        ? `GitHub rate limit reached. Try again ${retry}.`
        : `GitHub rate limit reached. Try again ${retry}, or run \`gh auth login\` so Orca can use your account's higher limit.`
    )
  }
  return new Error(`Could not list ${channel} builds (HTTP ${res.status}).`)
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

function parseReleaseEntry(
  entry: GitHubReleaseEntry,
  repo: string,
  platform: NodeJS.Platform,
  arch: NodeJS.Architecture,
  source: ReleaseSource
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
  // Why filter on assets rather than on a per-channel platform table: a release
  // is published as soon as one platform's leg finishes, and a leg can fail
  // outright. Asking what the release actually carries covers both without the
  // picker ever offering a row whose download 404s.
  const assetNames = readAssetNames(entry.assets)
  if (!hasInstallableArtifactForPlatform(platform, assetNames)) {
    return null
  }
  // Why by arch: the picker's download is installed by hand, so it must be the running slice.
  const installerAsset = findInstallerAssetName(platform, assetNames, arch)
  // Why null when it merely repeats the tag: GitHub titles an untitled release
  // with its tag name, and hourlies predating the naming change were created that
  // way too. Neither says anything the version beside it does not.
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

/**
 * Lists published releases for a channel so the dev picker can offer an exact
 * build — including older ones — to jump to.
 *
 * Why the REST API rather than the atom feed the routine update path uses: the
 * feed caps at the 10 newest entries, which cannot express "jump back to
 * yesterday's hourly". This runs only on explicit dev interaction, so it never
 * touches background checks; it sends the local gh token when there is one so
 * the request spends the user's own quota, not the per-IP bucket every
 * unauthenticated caller on the network shares.
 */
export async function listReleaseBuilds(
  channel: ReleaseChannel,
  platform: NodeJS.Platform = process.platform,
  source: ReleaseSource = PRIMARY_RELEASE_SOURCE,
  arch: NodeJS.Architecture = process.arch
): Promise<ReleaseBuild[]> {
  const repo = getReleaseRepoForChannel(channel, source.id)
  // Why: while the gh breaker has the token's core bucket marked spent, an
  // authenticated request is a guaranteed 403 — go straight to the per-IP bucket.
  const credential = await resolveReleaseApiToken()
  const tokenBucketBlocked =
    credential !== null &&
    getGhRateLimitBlockedUntilMs('core', Date.now(), credential.rateLimitScope) !== null
  const token = tokenBucketBlocked ? null : (credential?.token ?? null)
  let signedIn = credential !== null
  let res = await fetchReleases(repo, token)
  if (token && res.status === 401) {
    // Why: a revoked or expired keyring token answers 401, and the unauthenticated
    // request still lists a public repo — fall back instead of failing the picker.
    rejectReleaseApiToken()
    signedIn = false
    res = await fetchReleases(repo, null)
  } else if (token && isRateLimited(res) && isPrimaryRateLimited(res)) {
    // Why: the token's bucket and the per-IP bucket are separate, so the other one may
    // still have quota. Tell the breaker first so gh calls fail fast until the reset.
    const resetAtMs = rateLimitResetAtMs(res.headers, Date.now())
    if (resetAtMs !== null && credential) {
      recordGhPrimaryRateLimit('core', resetAtMs, credential.rateLimitScope)
    }
    res = await fetchReleases(repo, null)
  }
  if (!res.ok) {
    throw releaseListError(res, repo, channel, signedIn)
  }
  const payload: unknown = await res.json()
  if (!Array.isArray(payload)) {
    throw new Error(`Could not read the ${channel} release list.`)
  }
  const builds = payload
    .map((entry: GitHubReleaseEntry) => parseReleaseEntry(entry, repo, platform, arch, source))
    .filter((build): build is ReleaseBuild => build !== null)
    // Why: the main repo serves both stable and rc, so filter to the asked-for channel.
    .filter((build) => build.channel === channel)
  return sortReleaseBuildsNewestFirst(builds)
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
    throw new Error(
      `"${tag}" is not a valid release tag${source.prereleaseIdentifier === null ? '' : ` for ${source.label}`}.`
    )
  }
  const repo = getReleaseRepoForChannel(channel, source.id)
  return { tag, version, repo, feedUrl: getReleaseDownloadUrlForRepo(repo, tag) }
}
