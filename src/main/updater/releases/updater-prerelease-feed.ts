import { PRIMARY_RELEASE_SOURCE, type ReleaseSource } from '../../../shared/release-sources'
import { compareVersions, isPrereleaseVersion, isValidVersion } from './updater-fallback'
import {
  AssetProbeBudget,
  probeReleaseManifest,
  requestGitHubReleaseHead,
  type ReleaseManifestProbe
} from './updater-release-readiness'
import { getLatestReleasePageUrl, getReleaseTagPathPattern } from '../../updater-release-urls'
import { getMacSelfUpdateSourceFor } from '../mac-self-update/mac-self-update-activation'
import { judgeManifestProbe } from '../../updater-release-tag-manifest'
import {
  fetchReleaseFeedEntries,
  resolveVersionsFromManifests
} from './updater-release-feed-entries'

import {
  applyReleaseDelay,
  type DatedReleaseTag,
  type ReleaseDelayResult
} from './updater-release-delay'

export {
  verifyReleaseTagManifest,
  type ReleaseTagManifestVerdict,
  type ReleaseTagTarget
} from '../../updater-release-tag-manifest'

const MAX_MANIFEST_PROBE_CANDIDATES = 6

export function normalizeTagToVersion(tag: string): string {
  return tag.replace(/^v/i, '')
}

type ReleaseFeedTag = DatedReleaseTag

/** LOCAL: what the readiness pass probes with: the source's repo, and the probes the version pass already made. */
type ReleaseProbeScope = {
  source: ReleaseSource
  probes: Map<string, ReleaseManifestProbe>
  assetProbes: AssetProbeBudget
}

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
    const response = await requestGitHubReleaseHead(latestUrl)
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

  // Perf builds require explicit opt-in, even when semver considers them newer.
  const channelCandidates =
    options.releaseFilter === 'perf' && isPrimarySource
      ? tags.filter(({ tag }) => isPerfPrereleaseTag(tag))
      : includePrerelease
        ? tags.filter(({ tag }) => !isPerfPrereleaseTag(tag))
        : tags.filter(({ version }) => !isPrereleaseVersion(version))
  if (!options.minReleaseAgeMs || options.minReleaseAgeMs <= 0) {
    return resolveNewerReleaseTags(channelCandidates, currentVersion, maxTags, {
      source,
      probes,
      assetProbes
    })
  }
  const { eligible, releaseDelay } = applyReleaseDelay(
    channelCandidates,
    tags,
    currentVersion,
    options.minReleaseAgeMs,
    options.now ?? Date.now()
  )
  return {
    ...(await resolveNewerReleaseTags(eligible, currentVersion, maxTags, {
      source,
      probes,
      assetProbes
    })),
    releaseDelay
  }
}

async function resolveNewerReleaseTags(
  candidates: ReleaseFeedTag[],
  currentVersion: string,
  maxTags: number,
  { source, probes, assetProbes }: ReleaseProbeScope
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
  const macSelfUpdateSource = getMacSelfUpdateSourceFor(source)
  const manifestResults = (
    await Promise.all(
      probeCandidates.map(async ({ tag, version }) => ({
        tag,
        version,
        probe:
          probes.get(tag) ??
          (await probeReleaseManifest(tag, source.repo, assetProbes, macSelfUpdateSource))
      }))
    )
  ).flatMap(({ tag, version, probe }) => {
    const verdict = judgeManifestProbe(probe, version, source)
    if (verdict.kind === 'mismatch') {
      // Why skipped rather than not-ready: the mismatch is a publishing error, not a window that closes.
      console.warn(
        `[updater] ${source.id} release ${tag} advertises ${version} but its manifest names ${verdict.manifestVersion}; skipped`
      )
      return []
    }
    return [{ tag, version, readiness: verdict.kind }]
  })
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
