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
  type ReleaseManifestProbe
} from './updater-release-asset-readiness'
import { getReleaseAtomFeedUrl, getReleaseTagHrefPattern } from './updater-release-urls'
import { getMacSelfUpdateSourceFor } from './updater/mac-self-update/mac-self-update-activation'

export { getReleaseDownloadUrl } from './updater-release-urls'

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

function isSourceVersion(version: string, source: ReleaseSource): boolean {
  return isValidVersion(version) && getVersionReleaseSource(version) === source.id
}

/** The manifest names what electron-updater installs; only the advertised build of this source may be offered under the tag. */
function manifestNamesAdvertisedVersion(
  probe: ReleaseManifestProbe,
  version: string,
  source: ReleaseSource
): boolean {
  return (
    probe.version !== null &&
    isSourceVersion(probe.version, source) &&
    compareVersions(probe.version, version) === 0
  )
}

/** What a tag's manifest proves about the build advertised as `version`: `mismatch` names another build or source. */
export type ReleaseTagManifestVerdict =
  | { kind: 'ready' }
  | { kind: 'not-ready' }
  | { kind: 'unavailable' }
  | { kind: 'mismatch'; manifestVersion: string }

function judgeManifestProbe(
  probe: ReleaseManifestProbe,
  version: string,
  source: ReleaseSource
): ReleaseTagManifestVerdict {
  if (probe.version !== null && !manifestNamesAdvertisedVersion(probe, version, source)) {
    return { kind: 'mismatch', manifestVersion: probe.version }
  }
  // Why: a manifest that names no version cannot prove which build it installs.
  return {
    kind: probe.readiness === 'ready' && probe.version === null ? 'not-ready' : probe.readiness
  }
}

/** A tag, the version it advertises, and the repo its feed reads — a dev channel's repo is not its source's own. */
export type ReleaseTagTarget = {
  tag: string
  version: string
  repo: string
}

/** Reads the manifest published under the target's tag in its repo and says whether it installs the advertised version of `source` on this platform. */
export async function verifyReleaseTagManifest(
  target: ReleaseTagTarget,
  source: ReleaseSource
): Promise<ReleaseTagManifestVerdict> {
  return judgeManifestProbe(
    await probeReleaseManifest(
      target.tag,
      target.repo,
      undefined,
      getMacSelfUpdateSourceFor(source)
    ),
    target.version,
    source
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

function parseReleaseFeedEntries(body: string, source: ReleaseSource): ReleaseFeedEntry[] {
  const hrefPattern = getReleaseTagHrefPattern(source)
  const entries: ReleaseFeedEntry[] = []
  for (const entryMatch of body.matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
    const entry = entryMatch[1]
    const tag = [...entry.matchAll(hrefPattern)][0]?.[1]
    if (!tag) {
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

/**
 * Walks the GitHub releases atom feed and returns the tag of the newest
 * release strictly greater than `currentVersion`.
 *
 * Why: electron-updater's GitHubProvider filters the feed by channel, and
 * GitHub's /latest/download redirect can move between check and download.
 * By resolving the newest tag ourselves and pinning the generic provider at
 * `/releases/download/<tag>`, the manifest and downloaded asset stay tied to
 * the same release.
 *
 * Returns null if the fetch fails, the feed has no parseable tags, or
 * nothing in the feed is newer than `currentVersion`.
 */
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

  // Why: perf builds are explicit opt-in; regular prerelease checks should
  // stay on the main RC/stable series even though perf tags are semver-newer.
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

  // Why: a cancelled release can leave several feed entries without manifests,
  // but update checks must not stall on an unbounded run of 5s probes.
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
  // Why not-ready rather than no-newer: the primary source answers no-newer with GitHub's
  // /releases/latest/download redirect, which serves the very release skipped above. A verified
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
