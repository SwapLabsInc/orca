import { PRIMARY_RELEASE_SOURCE, type ReleaseSource } from '../shared/release-sources'
import { escapeRegex } from '../shared/string-utils'

/** GitHub release URLs the updater reads, built from a source's repo so no caller spells one. */

export function getReleaseDownloadUrlForRepo(repo: string, tag: string): string {
  return `https://github.com/${repo}/releases/download/${encodeURIComponent(tag)}`
}

export function getReleaseDownloadUrl(
  tag: string,
  source: ReleaseSource = PRIMARY_RELEASE_SOURCE
): string {
  return getReleaseDownloadUrlForRepo(source.repo, tag)
}

/** GitHub's moving redirect to the newest non-prerelease; only meaningful for the primary source. */
export function getLatestReleaseDownloadUrl(source: ReleaseSource): string {
  return `https://github.com/${source.repo}/releases/latest/download`
}

export function getReleaseAtomFeedUrl(source: ReleaseSource): string {
  return `https://github.com/${source.repo}/releases.atom`
}

export function getReleaseTagPageUrl(repo: string, tag: string): string {
  return `https://github.com/${repo}/releases/tag/${encodeURIComponent(tag)}`
}

/** Matches the `/releases/tag/<tag>` links in this source's atom feed and nothing from another repo. */
export function getReleaseTagHrefPattern(source: ReleaseSource): RegExp {
  return new RegExp(
    `href="https://github\\.com/${escapeRegex(source.repo)}/releases/tag/([^"]+)"`,
    'g'
  )
}

/** Matches absolute asset URLs that live under this repo's release downloads. */
export function getReleaseDownloadUrlPatternForRepo(repo: string): RegExp {
  return new RegExp(`^https://github\\.com/${escapeRegex(repo)}/releases/download/`, 'i')
}
