import { net } from 'electron'
import {
  PRIMARY_RELEASE_SOURCE,
  getVersionReleaseSource,
  type ReleaseSource
} from '../shared/release-sources'
import { compareVersions, isPrereleaseVersion, isValidVersion } from './updater-fallback'
import {
  AssetProbeBudget,
  probeReleaseManifest,
  requestGitHubReleaseHead,
  type ReleaseManifestProbe
} from './updater-release-asset-readiness'
import {
  getLatestReleasePageUrl,
  getReleaseAtomFeedUrl,
  getReleaseTagHrefPattern,
  getReleaseTagPathPattern
} from './updater-release-urls'
import { getMacSelfUpdateSourceFor } from './updater/mac-self-update/mac-self-update-activation'
import { isSourceVersion, judgeManifestProbe } from './updater-release-tag-manifest'

export { getReleaseDownloadUrl } from './updater-release-urls'
export {
  verifyReleaseTagManifest,
  type ReleaseTagManifestVerdict,
  type ReleaseTagTarget
} from './updater-release-tag-manifest'

const FETCH_TIMEOUT_MS = 5000
const MAX_MANIFEST_PROBE_CANDIDATES = 6

export function normalizeTagToVersion(tag: string): string {
  return tag.replace(/^v/i, '')
}

type ReleaseFeedTag = {
  tag: string
  version: string
}

/** One atom entry; `version` is null until something (tag, title, manifest) names it. */
type ReleaseFeedEntry = {
  tag: string
  version: string | null
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

const XML_ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'"
}

function decodeXmlText(text: string): string {
  return text.replace(/&(?:amp|lt|gt|quot|#39);/g, (entity) => XML_ENTITIES[entity] ?? entity)
}

/**
 * Which version a feed entry publishes. Primary-source tags are `v<version>`.
 * Other sources tag by git label (`swaplabs-v1.4.197+resume.1`), so their
 * version is read from the release title, and failing that from the manifest
 * later. A tag or title that names another source's version is dropped, so a
 * primary check can never pick up a fork build that strayed into its feed.
 */
function resolveEntryVersion(tag: string, title: string, source: ReleaseSource): string | null {
  const tagVersion = normalizeTagToVersion(tag)
  if (isSourceVersion(tagVersion, source)) {
    return tagVersion
  }
  if (source.prereleaseIdentifier === null) {
    return null
  }
  for (const token of title.split(/[\s•]+/)) {
    const candidate = normalizeTagToVersion(token)
    if (isSourceVersion(candidate, source)) {
      return candidate
    }
  }
  return null
}

/** LOCAL: the href carries the tag percent-encoded (`+` as `%2B`); every URL built from it encodes it again. */
function decodeFeedTag(href: string): string | null {
  try {
    return decodeURIComponent(decodeXmlText(href))
  } catch {
    return null
  }
}

/** LOCAL: a tag that is itself another source's version (`v1.4.216` mirrored into a fork) is never this source's release. */
function isOtherSourceVersionTag(tag: string, source: ReleaseSource): boolean {
  const tagVersion = normalizeTagToVersion(tag)
  return isValidVersion(tagVersion) && getVersionReleaseSource(tagVersion) !== source.id
}

function parseReleaseFeedEntries(body: string, source: ReleaseSource): ReleaseFeedEntry[] {
  const hrefPattern = getReleaseTagHrefPattern(source)
  const entries: ReleaseFeedEntry[] = []
  for (const entryMatch of body.matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
    const entry = entryMatch[1]
    const href = [...entry.matchAll(hrefPattern)][0]?.[1]
    const tag = href ? decodeFeedTag(href) : null
    // Why skip rather than probe: a non-primary source would otherwise spend manifest probes on them.
    if (!tag || isOtherSourceVersionTag(tag, source)) {
      continue
    }
    const title = decodeXmlText(entry.match(/<title[^>]*>([\s\S]*?)<\/title>/)?.[1] ?? '')
    entries.push({ tag, version: resolveEntryVersion(tag, title, source) })
  }
  return entries
}

async function fetchReleaseFeedEntries(source: ReleaseSource): Promise<ReleaseFeedEntry[] | null> {
  try {
    const res = await net.fetch(getReleaseAtomFeedUrl(source), {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
    })
    if (!res.ok) {
      return null
    }
    return parseReleaseFeedEntries(await res.text(), source)
  } catch {
    return null
  }
}

/**
 * Names the entries the tag and title could not, by reading each release's
 * manifest. The feed is in publish order, not version order, so no entry's
 * position says whether it is newer than the running build: every untitled
 * entry is a candidate, and the budget takes the most recently published ones.
 * Bounded, since every probe is a network round trip; probes are kept so the
 * readiness pass does not repeat them.
 */
async function resolveVersionsFromManifests(
  entries: ReleaseFeedEntry[],
  source: ReleaseSource,
  probes: Map<string, ReleaseManifestProbe>,
  assetProbes: AssetProbeBudget
): Promise<ReleaseFeedTag[]> {
  const unresolved = entries
    .filter((entry) => entry.version === null)
    .slice(0, MAX_MANIFEST_PROBE_CANDIDATES)
  const macSelfUpdateSource = getMacSelfUpdateSourceFor(source)
  const results = await Promise.all(
    unresolved.map(async ({ tag }) => ({
      tag,
      probe: await probeReleaseManifest(tag, source.repo, assetProbes, macSelfUpdateSource)
    }))
  )
  const resolved: ReleaseFeedTag[] = []
  for (const { tag, probe } of results) {
    probes.set(tag, probe)
    if (probe.version && isSourceVersion(probe.version, source)) {
      resolved.push({ tag, version: probe.version })
    }
  }
  return resolved
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
}

export type FetchNewerReleaseTagsResult =
  | { tags: string[]; state: 'ready' }
  | { tags: string[]; state: 'no-newer' }
  | { tags: string[]; state: 'not-ready'; lastGoodTag?: string }
  | { tags: string[]; state: 'unavailable'; unavailableReason: 'feed' | 'manifest' }

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
  const tags: ReleaseFeedTag[] = entries.flatMap(({ tag, version }) =>
    version ? [{ tag, version }] : []
  )
  if (!isPrimarySource) {
    tags.push(...(await resolveVersionsFromManifests(entries, source, probes, assetProbes)))
  }
  tags.sort((left, right) => compareVersions(right.version, left.version))

  // Perf builds require explicit opt-in, even when semver considers them newer.
  const candidates =
    options.releaseFilter === 'perf' && isPrimarySource
      ? tags.filter(({ tag }) => isPerfPrereleaseTag(tag))
      : includePrerelease
        ? tags.filter(({ tag }) => !isPerfPrereleaseTag(tag))
        : tags.filter(({ version }) => !isPrereleaseVersion(version))
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
