import { net } from 'electron'
import { parse } from 'yaml'
import { PrioritySemaphore } from '../shared/priority-semaphore'
import {
  getMacSelfUpdateManifestName,
  getMacSelfUpdateSignatureName
} from '../shared/mac-self-update-assets'
import { getUpdateManifestName } from '../shared/release-channel'
import { PRIMARY_RELEASE_SOURCE, type ReleaseSource } from '../shared/release-sources'
import { isValidVersion } from './updater-fallback'
import {
  getReleaseDownloadUrlForRepo,
  getReleaseDownloadUrlPatternForRepo
} from './updater-release-urls'

const FETCH_TIMEOUT_MS = 5000
const MAX_ASSET_PROBE_CONCURRENCY = 4

/**
 * The asset HEAD slots one update check may hold at once. Shared by every manifest the check
 * probes: a per-manifest cap still let six parallel manifests burst two dozen requests.
 */
export class AssetProbeBudget {
  private readonly slots = new PrioritySemaphore(MAX_ASSET_PROBE_CONCURRENCY)

  async run<T>(probe: () => Promise<T>): Promise<T> {
    const release = await this.slots.acquire(0)
    try {
      return await probe()
    } finally {
      release()
    }
  }
}

export type ReleaseReadiness = 'ready' | 'not-ready' | 'unavailable'

export type ReleaseManifestProbe = {
  readiness: ReleaseReadiness
  /** The version the manifest declares, when it could be read; what electron-updater will install. */
  version: string | null
}

function getReleaseAssetUrl(repo: string, tag: string, assetName: string): string {
  return `${getReleaseDownloadUrlForRepo(repo, tag)}/${encodeURIComponent(assetName)}`
}

type ManifestAssetEntry = {
  url?: unknown
  path?: unknown
}

type ParsedManifest = {
  version?: unknown
  files?: ManifestAssetEntry[]
  path?: unknown
  /** LOCAL: the self-update manifest names its one zip here. */
  file?: unknown
}

function getManifestAssetNames(parsed: ParsedManifest | null): string[] {
  const names = new Set<string>()
  for (const file of Array.isArray(parsed?.files) ? parsed.files : []) {
    const value = typeof file.url === 'string' ? file.url : file.path
    if (typeof value === 'string' && value.trim()) {
      names.add(value.trim())
    }
  }
  if (typeof parsed?.path === 'string' && parsed.path.trim()) {
    names.add(parsed.path.trim())
  }
  if (typeof parsed?.file === 'string' && parsed.file.trim()) {
    names.add(parsed.file.trim())
  }
  return [...names]
}

function getManifestVersion(parsed: ParsedManifest | null): string | null {
  const version = typeof parsed?.version === 'string' ? parsed.version.trim() : ''
  return version && isValidVersion(version) ? version : null
}

function getGitHubReleaseAssetReadiness(assetUrl: string): Promise<ReleaseReadiness> {
  return new Promise((resolve) => {
    const request = net.request({ method: 'HEAD', url: assetUrl, redirect: 'manual' })
    let settled = false
    const settle = (readiness: ReleaseReadiness): void => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timeout)
      resolve(readiness)
    }
    const timeout = setTimeout(() => {
      try {
        request.abort()
      } catch {
        // The request may already have been cancelled by Electron.
      }
      settle('unavailable')
    }, FETCH_TIMEOUT_MS)

    request.on('redirect', (statusCode) => {
      // Why: GitHub's 302 proves the asset exists without probing its signed storage URL.
      settle(statusCode >= 300 && statusCode < 400 ? 'ready' : 'unavailable')
    })
    request.on('response', (response) => {
      settle(
        response.statusCode === 404
          ? 'not-ready'
          : response.statusCode >= 200 && response.statusCode < 300
            ? 'ready'
            : 'unavailable'
      )
    })
    request.on('error', () => settle('unavailable'))
    try {
      request.end()
    } catch {
      settle('unavailable')
    }
  })
}

async function getReleaseAssetReadiness(
  repo: string,
  tag: string,
  assetName: string
): Promise<ReleaseReadiness> {
  const isRelativeAsset = !/^https?:\/\//i.test(assetName)
  const isGitHubReleaseAsset =
    process.platform === 'win32' &&
    (isRelativeAsset || getReleaseDownloadUrlPatternForRepo(repo).test(assetName))
  const assetUrl = isRelativeAsset
    ? getReleaseAssetUrl(repo, tag, assetName.split('/').findLast(Boolean) ?? assetName)
    : assetName
  if (isGitHubReleaseAsset) {
    return getGitHubReleaseAssetReadiness(assetUrl)
  }

  try {
    const res = await net.fetch(assetUrl, {
      method: 'HEAD',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
    })
    if (res.status === 404) {
      return 'not-ready'
    }
    return res.ok ? 'ready' : 'unavailable'
  } catch {
    return 'unavailable'
  }
}

/**
 * Whether a release tag can be installed on this platform right now: its updater
 * manifest exists and every asset the manifest names answers.
 *
 * Why: cancelled/draft releases can appear in GitHub's atom feed before they have
 * updater manifests or the ZIP/exe/AppImage assets referenced by those
 * manifests. Pinning to those tags makes download clicks 404.
 *
 * `repo` is the one the tag's feed reads — a dev channel's is not its source's own.
 * LOCAL: `macSelfUpdateSource` reads that source's per-slice self-update manifest (JSON, which
 * the YAML parser accepts) and its signature instead of `latest-mac.yml`.
 */
export async function probeReleaseManifest(
  tag: string,
  repo: string = PRIMARY_RELEASE_SOURCE.repo,
  assetProbes: AssetProbeBudget = new AssetProbeBudget(),
  macSelfUpdateSource: ReleaseSource | null = null
): Promise<ReleaseManifestProbe> {
  try {
    const manifestName = macSelfUpdateSource
      ? getMacSelfUpdateManifestName(macSelfUpdateSource, process.arch)
      : getUpdateManifestName(process.platform, process.arch)
    const manifestUrl = `${getReleaseDownloadUrlForRepo(repo, tag)}/${manifestName}`
    const res = await net.fetch(manifestUrl, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
    if (res.status === 404) {
      return { readiness: 'not-ready', version: null }
    }
    if (!res.ok) {
      return { readiness: 'unavailable', version: null }
    }
    const manifestText = await res.text()
    let parsed: ParsedManifest | null
    try {
      parsed = parse(manifestText)
    } catch {
      return { readiness: 'not-ready', version: null }
    }
    const version = getManifestVersion(parsed)
    const assetNames = getManifestAssetNames(parsed)
    if (assetNames.length === 0) {
      return { readiness: 'not-ready', version }
    }
    if (macSelfUpdateSource) {
      // Why: the signature is uploaded last, so its presence is what makes the release installable.
      assetNames.push(getMacSelfUpdateSignatureName(manifestName))
    }
    const assetResults = await Promise.all(
      assetNames.map((assetName) =>
        assetProbes.run(() => getReleaseAssetReadiness(repo, tag, assetName))
      )
    )
    const readiness = assetResults.includes('not-ready')
      ? 'not-ready'
      : assetResults.includes('unavailable')
        ? 'unavailable'
        : 'ready'
    return { readiness, version }
  } catch {
    return { readiness: 'unavailable', version: null }
  }
}
