import { net } from 'electron'
import { normalizeTagToVersion } from '../../../shared/release-channel'
import { getVersionReleaseSource, type ReleaseSource } from '../../../shared/release-sources'
import { isSourceVersion } from '../../updater-release-tag-manifest'
import { getMacSelfUpdateSourceFor } from '../mac-self-update/mac-self-update-activation'
import { isValidVersion } from './updater-fallback'
import type { DatedReleaseTag } from './updater-release-delay'
import {
  FETCH_TIMEOUT_MS,
  probeReleaseManifest,
  type AssetProbeBudget,
  type ReleaseManifestProbe
} from './updater-release-readiness'
import { getReleaseAtomFeedUrl, getReleaseTagHrefPattern } from '../../updater-release-urls'

// LOCAL: reads any release source's atom feed, whose tags need not carry their version.

const MAX_VERSION_PROBE_ENTRIES = 6
const ENTRY_UPDATED_RE = /<updated>([^<]+)<\/updated>/

/** One atom entry; `version` is null until something (tag, title, manifest) names it. */
type ReleaseFeedEntry = {
  tag: string
  version: string | null
  releasedAt: number | null
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
    const releasedAt = Date.parse(entry.match(ENTRY_UPDATED_RE)?.[1] ?? '')
    entries.push({
      tag,
      version: resolveEntryVersion(tag, title, source),
      releasedAt: Number.isNaN(releasedAt) ? null : releasedAt
    })
  }
  return entries
}

export async function fetchReleaseFeedEntries(
  source: ReleaseSource
): Promise<ReleaseFeedEntry[] | null> {
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
export async function resolveVersionsFromManifests(
  entries: ReleaseFeedEntry[],
  source: ReleaseSource,
  probes: Map<string, ReleaseManifestProbe>,
  assetProbes: AssetProbeBudget
): Promise<DatedReleaseTag[]> {
  const unresolved = entries
    .filter((entry) => entry.version === null)
    .slice(0, MAX_VERSION_PROBE_ENTRIES)
  const macSelfUpdateSource = getMacSelfUpdateSourceFor(source)
  const results = await Promise.all(
    unresolved.map(async ({ tag, releasedAt }) => ({
      tag,
      releasedAt,
      probe: await probeReleaseManifest(tag, source.repo, assetProbes, macSelfUpdateSource)
    }))
  )
  const resolved: DatedReleaseTag[] = []
  for (const { tag, releasedAt, probe } of results) {
    probes.set(tag, probe)
    if (probe.version && isSourceVersion(probe.version, source)) {
      resolved.push({ tag, version: probe.version, releasedAt })
    }
  }
  return resolved
}
