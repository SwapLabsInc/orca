import { PRIMARY_RELEASE_SOURCE, type ReleaseSource } from '../../../shared/updater/release-sources'
import { compareVersions, isPrereleaseVersion, isValidVersion } from './updater-fallback'
import {
  AssetProbeBudget,
  probeReleaseManifest,
  requestReleaseHead,
  type ReleaseManifestProbe
} from './updater-release-readiness'
import { getLatestReleasePageUrl, getReleaseTagPathPattern } from '../../updater-release-urls'
import { judgeCandidateManifests, type ReleaseProbeScope } from '../../updater-release-tag-manifest'
import {
  fetchReleaseFeedEntries,
  resolveVersionsFromManifests
} from './updater-release-feed-entries'

import {
  applyReleaseDelay,
  isReleaseOldEnough,
  type DatedReleaseTag,
  type ReleaseDelayResult
} from './updater-release-delay'
import { listMainRepoReleaseBuildsUntil } from './updater-release-builds'
import type { ReleaseBuild } from '../../../shared/updater/release-channel'

export {
  verifyReleaseTagManifest,
  type ReleaseTagManifestVerdict,
  type ReleaseTagTarget
} from '../../updater-release-tag-manifest'

// Releases past the feed don't change and newer ones come from Atom, so a list that settled the delay stays accurate.
const OLDER_RELEASES_TTL_MS = 6 * 60 * 60 * 1000
let olderReleasesCache: {
  tags: DatedReleaseTag[]
  expiresAt: number
  exhaustive: boolean
} | null = null

const MAX_MANIFEST_PROBE_CANDIDATES = 6

export function normalizeTagToVersion(tag: string): string {
  return tag.replace(/^v/i, '')
}

type ReleaseFeedTag = DatedReleaseTag

export function isPerfPrereleaseTag(tag: string): boolean {
  const version = normalizeTagToVersion(tag)
  const match = version.match(/^\d+\.\d+\.\d+-([0-9A-Za-z-.]+)(?:\+[0-9A-Za-z-.]+)?$/)
  const identifiers = match?.[1]?.split('.') ?? []
  return (
    identifiers.length === 3 &&
    identifiers[0] === 'rc' &&
    /^\d+$/.test(identifiers[1]) &&
    identifiers[2] === 'perf'
  )
}

export async function fetchLatestStableReleaseTag(
  source: ReleaseSource = PRIMARY_RELEASE_SOURCE
): Promise<string | null> {
  try {
    // Resolve only the release-page redirect; installer redirects continue on to signed storage URLs.
    const latestUrl = getLatestReleasePageUrl(source)
    const response = await requestReleaseHead(latestUrl)
    if (!response?.redirectUrl || response.statusCode < 300 || response.statusCode >= 400) {
      return null
    }
    const target = new URL(response.redirectUrl, latestUrl)
    const match = target.pathname.match(getReleaseTagPathPattern(source))
    if (target.origin !== 'https://github.com' || !match) {
      return null
    }
    const tag = decodeURIComponent(match[1])
    const version = normalizeTagToVersion(tag)
    if (!isValidVersion(version) || isPrereleaseVersion(version)) {
      return null
    }
    return (await probeReleaseManifest(tag, source.repo)).readiness === 'ready' ? tag : null
  } catch {
    return null
  }
}

// Concrete tags keep manifests and downloaded assets on the same release.
type FetchNewerReleaseTagOptions = {
  includePrerelease?: boolean
  releaseFilter?: 'perf'
  /** The source whose feed to read; defaults to the primary, whose semantics are unchanged. */
  source?: ReleaseSource
  /** User update delay: only releases public at least this long are offered. */
  minReleaseAgeMs?: number
  minimumVersion?: string
  now?: number
}

type FetchNewerReleaseTagsBaseResult =
  | { tags: string[]; state: 'ready' }
  | { tags: string[]; state: 'no-newer' }
  | { tags: string[]; state: 'not-ready'; lastGoodTag?: string }
  | { tags: string[]; state: 'unavailable'; unavailableReason: 'feed' | 'manifest' }

export type FetchNewerReleaseTagsResult = FetchNewerReleaseTagsBaseResult & {
  releaseDelay?: ReleaseDelayResult
}

export async function fetchNewerReleaseTag(
  currentVersion: string,
  options: FetchNewerReleaseTagOptions = {}
): Promise<string | null> {
  return (await fetchNewerReleaseTags(currentVersion, 1, options))[0] ?? null
}

export async function fetchNewerReleaseTags(
  currentVersion: string,
  maxTags: number,
  options: FetchNewerReleaseTagOptions = {}
): Promise<string[]> {
  return (await fetchNewerReleaseTagsWithReadiness(currentVersion, maxTags, options)).tags
}

export async function fetchNewerReleaseTagsWithReadiness(
  currentVersion: string,
  maxTags: number,
  options: FetchNewerReleaseTagOptions = {}
): Promise<FetchNewerReleaseTagsResult> {
  const source = options.source ?? PRIMARY_RELEASE_SOURCE
  const isPrimarySource = source.prereleaseIdentifier === null
  // Why: a non-primary source publishes every build as a prerelease, so a stable-only check would find nothing.
  const includePrerelease = isPrimarySource ? (options.includePrerelease ?? true) : true
  if (maxTags <= 0) {
    return { tags: [], state: 'no-newer' }
  }
  const entries = await fetchReleaseFeedEntries(source)
  if (!entries) {
    return { tags: [], state: 'unavailable', unavailableReason: 'feed' }
  }
  const probes = new Map<string, ReleaseManifestProbe>()
  // Why one budget for the whole check: every manifest probed below shares its asset HEAD slots.
  const assetProbes = new AssetProbeBudget()
  const tags: ReleaseFeedTag[] = entries.flatMap(({ tag, version, releasedAt }) =>
    version ? [{ tag, version, releasedAt }] : []
  )
  if (!isPrimarySource) {
    tags.push(...(await resolveVersionsFromManifests(entries, source, probes, assetProbes)))
  }
  tags.sort((left, right) => compareVersions(right.version, left.version))

  // Why: only the primary source publishes perf builds.
  const releaseFilter = isPrimarySource ? options.releaseFilter : undefined
  const scope: ReleaseProbeScope = { source, probes, assetProbes }
  const minimum = options.minimumVersion
  const candidates = (list: ReleaseFeedTag[]): ReleaseFeedTag[] => {
    const channel = selectChannelCandidates(list, includePrerelease, releaseFilter)
    return minimum
      ? channel.filter(({ version }) => compareVersions(version, minimum) >= 0)
      : channel
  }
  const channelCandidates = candidates(tags)
  if (!options.minReleaseAgeMs || options.minReleaseAgeMs <= 0) {
    // LOCAL: the REST list is the primary repo's, so only the primary source reads it.
    if (channelCandidates.length || !minimum || !isPrimarySource) {
      return resolveNewerReleaseTags(channelCandidates, currentVersion, maxTags, scope)
    }
    const older = await fetchOlderReleaseTags(
      (list) => candidates(list).length > 0,
      options.now ?? Date.now()
    )
    return resolveNewerReleaseTags(
      candidates(mergeReleaseTags(tags, older ?? [])),
      currentVersion,
      maxTags,
      scope
    )
  }
  const now = options.now ?? Date.now()
  const cutoff = now - options.minReleaseAgeMs
  // Newest-first lists settle the delay at an aged-out newer release or our own release; an older
  // line's recent maintenance release does not prove that history is complete.
  const settlesDelay = (list: ReleaseFeedTag[]): boolean =>
    list.some(({ version }) => compareVersions(version, currentVersion) === 0) ||
    candidates(list).some(
      (entry) =>
        isReleaseOldEnough(entry, cutoff) && compareVersions(entry.version, currentVersion) > 0
    ) ||
    (minimum !== undefined &&
      candidates(list).some(({ version }) => compareVersions(version, minimum) === 0))
  // Atom keeps only ~10 entries, so an aged-out release may predate it.
  // Judge REST pages through the merge so Atom's later `updated` time wins, as it does below.
  // LOCAL: the REST list is the primary repo's, so only the primary source reads it.
  const olderTags =
    !isPrimarySource || settlesDelay(tags)
      ? null
      : await fetchOlderReleaseTags((older) => settlesDelay(mergeReleaseTags(tags, older)), now)
  const allTags = olderTags ? mergeReleaseTags(tags, olderTags) : tags
  const allCandidates = candidates(allTags)
  const { eligible, releaseDelay } = applyReleaseDelay(
    allCandidates,
    allTags,
    currentVersion,
    options.minReleaseAgeMs,
    now
  )
  const bypassDelayForMinimum = minimum !== undefined && eligible.length === 0
  const result = await resolveNewerReleaseTags(
    bypassDelayForMinimum ? allCandidates.toReversed() : eligible,
    currentVersion,
    bypassDelayForMinimum ? 1 : maxTags,
    scope
  )
  return { ...result, releaseDelay }
}

// Perf builds require explicit opt-in, even when semver considers them newer.
function selectChannelCandidates(
  tags: ReleaseFeedTag[],
  includePrerelease: boolean,
  releaseFilter: FetchNewerReleaseTagOptions['releaseFilter']
): ReleaseFeedTag[] {
  if (releaseFilter === 'perf') {
    return tags.filter(({ tag }) => isPerfPrereleaseTag(tag))
  }
  return includePrerelease
    ? tags.filter(({ tag }) => !isPerfPrereleaseTag(tag))
    : tags.filter(({ version }) => !isPrereleaseVersion(version))
}

async function fetchOlderReleaseTags(
  settlesDelay: (tags: ReleaseFeedTag[]) => boolean,
  now: number
): Promise<ReleaseFeedTag[] | null> {
  if (
    olderReleasesCache &&
    olderReleasesCache.expiresAt > now &&
    (olderReleasesCache.exhaustive || settlesDelay(olderReleasesCache.tags))
  ) {
    return olderReleasesCache.tags
  }
  try {
    const builds = await listMainRepoReleaseBuildsUntil((listed) =>
      settlesDelay(listed.map(toDatedReleaseTag))
    )
    const tags = builds.map(toDatedReleaseTag)
    // An unsettled list ran to the last page or the cap, so refetching within the TTL finds nothing more.
    olderReleasesCache = {
      tags,
      expiresAt: now + OLDER_RELEASES_TTL_MS,
      exhaustive: !settlesDelay(tags)
    }
    return tags
  } catch {
    // Rate limits or outages keep the Atom-only result, which holds the update (fail closed).
    return null
  }
}

function toDatedReleaseTag({ tag, version, publishedAt }: ReleaseBuild): ReleaseFeedTag {
  const releasedAt = publishedAt ? Date.parse(publishedAt) : Number.NaN
  return { tag, version, releasedAt: Number.isNaN(releasedAt) ? null : releasedAt }
}

// Atom entries win; REST pages can repeat a release published while paging.
function mergeReleaseTags(
  feedTags: ReleaseFeedTag[],
  olderTags: ReleaseFeedTag[]
): ReleaseFeedTag[] {
  const byTag = new Map<string, ReleaseFeedTag>()
  for (const entry of [...feedTags, ...olderTags]) {
    if (!byTag.has(entry.tag)) {
      byTag.set(entry.tag, entry)
    }
  }
  return [...byTag.values()].sort((left, right) => compareVersions(right.version, left.version))
}

async function resolveNewerReleaseTags(
  candidates: ReleaseFeedTag[],
  currentVersion: string,
  maxTags: number,
  scope: ReleaseProbeScope
): Promise<FetchNewerReleaseTagsBaseResult> {
  const newestNewerIndex = candidates.findIndex(
    ({ version }) => compareVersions(version, currentVersion) > 0
  )
  if (newestNewerIndex === -1) {
    return { tags: [], state: 'no-newer' }
  }

  // Bound probes when cancelled releases leave multiple entries without manifests.
  const probeCandidates = candidates.slice(
    newestNewerIndex,
    newestNewerIndex + MAX_MANIFEST_PROBE_CANDIDATES
  )
  const manifestResults = await judgeCandidateManifests(probeCandidates, scope)
  // Why not-ready rather than no-newer: the primary source answers no-newer by pinning the tag
  // GitHub's /releases/latest names, which is the very release skipped above. A verified
  // last-good tag gives electron-updater a real result instead, and the publishing-window retry
  // notices a re-upload under the same tag.
  if (!manifestResults.some(({ version }) => compareVersions(version, currentVersion) > 0)) {
    const lastGoodTag = manifestResults.find(({ readiness }) => readiness === 'ready')?.tag
    return lastGoodTag
      ? { tags: [], state: 'not-ready', lastGoodTag }
      : { tags: [], state: 'not-ready' }
  }

  const primaryIndex = manifestResults.findIndex(
    ({ readiness, version }) =>
      readiness === 'ready' && compareVersions(version, currentVersion) > 0
  )
  if (primaryIndex === -1) {
    if (manifestResults[0]?.readiness === 'unavailable') {
      return { tags: [], state: 'unavailable', unavailableReason: 'manifest' }
    }
    const lastGoodTag = manifestResults.find(({ readiness }) => readiness === 'ready')?.tag
    return lastGoodTag
      ? { tags: [], state: 'not-ready', lastGoodTag }
      : { tags: [], state: 'not-ready' }
  }

  if (primaryIndex > 0) {
    if (manifestResults[0]?.readiness === 'unavailable') {
      return { tags: [], state: 'unavailable', unavailableReason: 'manifest' }
    }
    return { tags: [], state: 'not-ready', lastGoodTag: manifestResults[primaryIndex].tag }
  }

  return {
    tags: manifestResults
      .slice(primaryIndex)
      .filter(({ readiness }) => readiness === 'ready')
      .slice(0, maxTags)
      .map(({ tag }) => tag),
    state: 'ready'
  }
}
