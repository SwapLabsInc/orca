import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installNetRequestFetchAdapter } from './updater-net-request.fixture'
import {
  FORK_RELEASE_SOURCES_LITERAL,
  setReleaseSourcesLiteralForTest
} from '../shared/release-sources.fixture'

const ORIGINAL_PLATFORM = process.platform

const { netFetchMock, netRequestMock } = vi.hoisted(() => ({
  netFetchMock: vi.fn(),
  netRequestMock: vi.fn()
}))

vi.mock('electron', () => ({
  net: { fetch: netFetchMock, request: netRequestMock }
}))

function buildAtomFeed(tags: string[]): string {
  const entries = tags
    .map(
      (tag) =>
        `<entry><link rel="alternate" type="text/html" href="https://github.com/stablyai/orca/releases/tag/${tag}"/><title>${tag}</title></entry>`
    )
    .join('')
  return `<?xml version="1.0" encoding="UTF-8"?><feed>${entries}</feed>`
}

/** `manifestVersion` overrides the version line; null omits it. */
function buildManifest(tag: string, manifestVersion?: string | null): string {
  const version = tag.replace(/^v/i, '')
  return [
    ...(manifestVersion === null ? [] : [`version: ${manifestVersion ?? version}`]),
    'files:',
    `  - url: Orca-${version}-arm64-mac.zip`,
    '    sha512: test',
    `path: Orca-${version}-arm64-mac.zip`
  ].join('\n')
}

function respondWithAtom(
  tags: string[],
  missingManifestTags: string[] = [],
  missingAssetTags: string[] = [],
  unavailableManifestTags: string[] = [],
  manifestVersions: Record<string, string | null> = {}
): void {
  const missingManifests = new Set(missingManifestTags)
  const missingAssets = new Set(missingAssetTags)
  const unavailableManifests = new Set(unavailableManifestTags)
  netFetchMock.mockImplementation((url: string, init?: { method?: string }) => {
    if (url === 'https://github.com/stablyai/orca/releases.atom') {
      return Promise.resolve({
        ok: true,
        text: () => Promise.resolve(buildAtomFeed(tags))
      })
    }

    const manifestMatch = url.match(/\/releases\/download\/([^/]+)\/latest(?:-[a-z]+)?\.yml$/)
    if (manifestMatch) {
      const tag = decodeURIComponent(manifestMatch[1])
      if (unavailableManifests.has(tag)) {
        return Promise.resolve({
          ok: false,
          status: 503,
          text: () => Promise.resolve('')
        })
      }
      return Promise.resolve({
        ok: !missingManifests.has(tag),
        status: missingManifests.has(tag) ? 404 : 200,
        text: () => Promise.resolve(buildManifest(tag, manifestVersions[tag]))
      })
    }

    const assetMatch = url.match(/\/releases\/download\/([^/]+)\/(.+)$/)
    if (assetMatch && init?.method === 'HEAD') {
      return Promise.resolve({
        ok: !missingAssets.has(decodeURIComponent(assetMatch[1])),
        status: missingAssets.has(decodeURIComponent(assetMatch[1])) ? 404 : 200,
        text: () => Promise.resolve('')
      })
    }

    return Promise.resolve({
      ok: false,
      text: () => Promise.resolve('')
    })
  })
}

function setPlatformForTest(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform })
}

describe('fetchNewerReleaseTag', () => {
  beforeEach(() => {
    vi.resetModules()
    netFetchMock.mockReset()
    netRequestMock.mockReset()
    installNetRequestFetchAdapter(netRequestMock, netFetchMock)
  })

  afterEach(() => {
    setPlatformForTest(ORIGINAL_PLATFORM)
  })

  it('returns the newest stable tag when the user is on an RC and a newer stable exists', async () => {
    respondWithAtom(['v1.3.19', 'v1.3.19-rc.6', 'v1.3.19-rc.4', 'v1.3.18'])
    const { fetchNewerReleaseTag } = await import('./updater-prerelease-feed')
    expect(await fetchNewerReleaseTag('1.3.19-rc.6')).toBe('v1.3.19')
  })

  it('returns the newest RC tag when no stable is newer than the current RC', async () => {
    respondWithAtom(['v1.3.19-rc.6', 'v1.3.19-rc.4', 'v1.3.18'])
    const { fetchNewerReleaseTag } = await import('./updater-prerelease-feed')
    expect(await fetchNewerReleaseTag('1.3.19-rc.4')).toBe('v1.3.19-rc.6')
  })

  it('can exclude prerelease tags for stable-channel checks', async () => {
    respondWithAtom(['v1.4.1-rc.0', 'v1.4.0', 'v1.3.52-rc.3', 'v1.3.51'])
    const { fetchNewerReleaseTag } = await import('./updater-prerelease-feed')
    expect(await fetchNewerReleaseTag('1.3.51', { includePrerelease: false })).toBe('v1.4.0')
  })

  it.each([
    ['darwin', 'latest-mac.yml'],
    ['linux', 'latest-linux.yml'],
    ['win32', 'latest.yml']
  ] satisfies [NodeJS.Platform, string][])(
    'probes the %s platform manifest',
    async (platform, manifestName) => {
      setPlatformForTest(platform)
      const manifestUrls: string[] = []
      const assetUrls: string[] = []

      netFetchMock.mockImplementation((url: string, init?: { method?: string }) => {
        if (url === 'https://github.com/stablyai/orca/releases.atom') {
          return Promise.resolve({
            ok: true,
            text: () => Promise.resolve(buildAtomFeed(['v1.4.1']))
          })
        }

        if (url.endsWith(manifestName)) {
          manifestUrls.push(url)
          return Promise.resolve({
            ok: true,
            text: () => Promise.resolve(buildManifest('v1.4.1'))
          })
        }

        if (init?.method === 'HEAD') {
          assetUrls.push(url)
        }
        return Promise.resolve({
          ok: true,
          text: () => Promise.resolve('')
        })
      })

      const { fetchNewerReleaseTag } = await import('./updater-prerelease-feed')

      expect(await fetchNewerReleaseTag('1.4.0')).toBe('v1.4.1')
      expect(manifestUrls).toEqual([
        `https://github.com/stablyai/orca/releases/download/v1.4.1/${manifestName}`
      ])
      expect(assetUrls).toEqual([
        'https://github.com/stablyai/orca/releases/download/v1.4.1/Orca-1.4.1-arm64-mac.zip'
      ])
      expect(netRequestMock).toHaveBeenCalledTimes(platform === 'win32' ? 1 : 0)
    }
  )

  it('returns null for stable-channel checks when only prereleases are newer', async () => {
    respondWithAtom(['v1.4.1-rc.0', 'v1.3.52-rc.3', 'v1.3.51'])
    const { fetchNewerReleaseTag } = await import('./updater-prerelease-feed')
    expect(await fetchNewerReleaseTag('1.3.51', { includePrerelease: false })).toBe(null)
  })

  it('returns null when nothing in the feed is newer than the current version', async () => {
    respondWithAtom(['v1.3.18', 'v1.3.17'])
    const { fetchNewerReleaseTag } = await import('./updater-prerelease-feed')
    expect(await fetchNewerReleaseTag('1.3.19-rc.6')).toBe(null)
  })

  it('ignores entries with unparseable tags', async () => {
    respondWithAtom(['not-a-version', 'v1.3.20', 'garbage'])
    const { fetchNewerReleaseTag } = await import('./updater-prerelease-feed')
    expect(await fetchNewerReleaseTag('1.3.19-rc.6')).toBe('v1.3.20')
  })

  it('returns null when the fetch is not ok', async () => {
    netFetchMock.mockResolvedValue({ ok: false, text: () => Promise.resolve('') })
    const { fetchNewerReleaseTag } = await import('./updater-prerelease-feed')
    expect(await fetchNewerReleaseTag('1.3.19-rc.6')).toBe(null)
  })

  it('returns null when the fetch throws', async () => {
    netFetchMock.mockRejectedValue(new Error('network down'))
    const { fetchNewerReleaseTag } = await import('./updater-prerelease-feed')
    expect(await fetchNewerReleaseTag('1.3.19-rc.6')).toBe(null)
  })

  it('picks semver-newest across a mixed-order feed', async () => {
    // atom feed sort by publish time, not version — verify we pick by semver
    respondWithAtom(['v1.2.0', 'v1.3.19', 'v1.3.19-rc.6', 'v1.3.20-rc.1', 'v1.3.18'])
    const { fetchNewerReleaseTag } = await import('./updater-prerelease-feed')
    expect(await fetchNewerReleaseTag('1.3.19-rc.6')).toBe('v1.3.20-rc.1')
  })

  it('ignores perf-tagged prereleases for regular RC checks', async () => {
    respondWithAtom(['v1.4.121-rc.6.perf', 'v1.4.121-rc.6', 'v1.4.121-rc.5'])

    const { fetchNewerReleaseTag } = await import('./updater-prerelease-feed')

    expect(await fetchNewerReleaseTag('1.4.121-rc.5', { includePrerelease: true })).toBe(
      'v1.4.121-rc.6'
    )
  })

  it('reports no RC update when only perf-tagged prereleases are newer', async () => {
    respondWithAtom(['v1.4.121-rc.6.perf', 'v1.4.121-rc.5'])

    const { fetchNewerReleaseTagsWithReadiness } = await import('./updater-prerelease-feed')

    await expect(
      fetchNewerReleaseTagsWithReadiness('1.4.121-rc.5', 1, { includePrerelease: true })
    ).resolves.toEqual({
      tags: [],
      state: 'no-newer'
    })
  })

  it('picks the semver-newest perf-tagged prerelease', async () => {
    respondWithAtom([
      'v1.4.121-rc.6.perf',
      'v1.4.121-rc.7',
      'v1.4.121-rc.5.perf',
      'v1.4.121-rc.6',
      'v1.4.122'
    ])

    const { fetchNewerReleaseTag } = await import('./updater-prerelease-feed')

    expect(
      await fetchNewerReleaseTag('1.4.120', {
        includePrerelease: true,
        releaseFilter: 'perf'
      })
    ).toBe('v1.4.121-rc.6.perf')
  })

  it('matches only literal rc.N.perf prerelease tags for perf checks', async () => {
    respondWithAtom([
      'v1.4.121-rc.7.performance',
      'v1.4.121-beta.7.perf',
      'v1.4.121-rc.7.perf.extra',
      'v1.4.121-rc.6.perf'
    ])

    const { fetchNewerReleaseTag, isPerfPrereleaseTag } = await import('./updater-prerelease-feed')

    expect(isPerfPrereleaseTag('v1.4.121-rc.6.perf')).toBe(true)
    expect(isPerfPrereleaseTag('v1.4.121-rc.7.performance')).toBe(false)
    expect(isPerfPrereleaseTag('v1.4.121-beta.7.perf')).toBe(false)
    expect(isPerfPrereleaseTag('v1.4.121-rc.7.perf.extra')).toBe(false)
    expect(
      await fetchNewerReleaseTag('1.4.120', {
        includePrerelease: true,
        releaseFilter: 'perf'
      })
    ).toBe('v1.4.121-rc.6.perf')
  })

  it('reports no perf update instead of falling back to stable or RC tags', async () => {
    respondWithAtom(['v1.4.122', 'v1.4.121-rc.7', 'v1.4.121'])

    const { fetchNewerReleaseTagsWithReadiness } = await import('./updater-prerelease-feed')

    await expect(
      fetchNewerReleaseTagsWithReadiness('1.4.120', 1, {
        includePrerelease: true,
        releaseFilter: 'perf'
      })
    ).resolves.toEqual({
      tags: [],
      state: 'no-newer'
    })
  })

  it('returns a bounded fallback candidate after the newest newer tag', async () => {
    respondWithAtom(['v1.3.51-rc.7', 'v1.3.51-rc.6', 'v1.3.51-rc.5'])
    const { fetchNewerReleaseTags } = await import('./updater-prerelease-feed')
    expect(await fetchNewerReleaseTags('1.3.51-rc.6', 2)).toEqual(['v1.3.51-rc.7', 'v1.3.51-rc.6'])
  })

  it('reports not-ready with last-good when newer platform updater manifests are missing', async () => {
    respondWithAtom(
      ['v1.4.1-rc.4', 'v1.4.1-rc.3', 'v1.4.1-rc.2', 'v1.4.1-rc.1'],
      ['v1.4.1-rc.4', 'v1.4.1-rc.3']
    )

    const { fetchNewerReleaseTag, fetchNewerReleaseTagsWithReadiness } =
      await import('./updater-prerelease-feed')

    expect(await fetchNewerReleaseTag('1.4.1-rc.1')).toBeNull()
    expect(await fetchNewerReleaseTagsWithReadiness('1.4.1-rc.1', 2)).toEqual({
      tags: [],
      state: 'not-ready',
      lastGoodTag: 'v1.4.1-rc.2'
    })
  })

  it('reports manifest transport failures as unavailable', async () => {
    respondWithAtom(['v1.4.2'], [], [], ['v1.4.2'])

    const { fetchNewerReleaseTagsWithReadiness } = await import('./updater-prerelease-feed')

    await expect(fetchNewerReleaseTagsWithReadiness('1.4.0', 1)).resolves.toEqual({
      tags: [],
      state: 'unavailable',
      unavailableReason: 'manifest'
    })
  })

  it('reports not-ready with last-good when newer manifest assets are not reachable yet', async () => {
    respondWithAtom(['v1.4.3', 'v1.4.2', 'v1.4.1'], [], ['v1.4.3'])

    const { fetchNewerReleaseTag, fetchNewerReleaseTagsWithReadiness } =
      await import('./updater-prerelease-feed')

    expect(await fetchNewerReleaseTag('1.4.0')).toBeNull()
    expect(await fetchNewerReleaseTagsWithReadiness('1.4.0', 1)).toEqual({
      tags: [],
      state: 'not-ready',
      lastGoodTag: 'v1.4.2'
    })
  })

  it('returns null when the only newer tag has a manifest but its asset still 404s', async () => {
    respondWithAtom(['v1.4.27'], [], ['v1.4.27'])

    const { fetchNewerReleaseTag } = await import('./updater-prerelease-feed')

    expect(await fetchNewerReleaseTag('1.4.26')).toBeNull()
  })

  it('does not return the current tag as the primary update when newer manifests are missing', async () => {
    respondWithAtom(['v1.4.1-rc.3', 'v1.4.1-rc.2', 'v1.4.1-rc.1'], ['v1.4.1-rc.3', 'v1.4.1-rc.2'])

    const { fetchNewerReleaseTag, fetchNewerReleaseTags } =
      await import('./updater-prerelease-feed')

    expect(await fetchNewerReleaseTag('1.4.1-rc.1')).toBeNull()
    expect(await fetchNewerReleaseTags('1.4.1-rc.1', 2)).toEqual([])
  })

  // Why: the manifest is what electron-updater installs. A tag whose manifest names another
  // version was offered as the tag's version anyway; one naming no version cannot be verified.
  it('never offers a tag whose manifest names a version other than the advertised one', async () => {
    respondWithAtom(['v1.4.2', 'v1.4.1'], [], [], [], { 'v1.4.2': '1.4.1' })
    const { fetchNewerReleaseTag, fetchNewerReleaseTagsWithReadiness } =
      await import('./updater-prerelease-feed')

    expect(await fetchNewerReleaseTag('1.4.0')).toBe('v1.4.1')

    respondWithAtom(['v1.4.2', 'v1.4.1'], [], [], [], { 'v1.4.2': null })
    expect(await fetchNewerReleaseTagsWithReadiness('1.4.0', 1)).toEqual({
      tags: [],
      state: 'not-ready',
      lastGoodTag: 'v1.4.1'
    })
  })

  // Why: no-newer sends the primary source to GitHub's /releases/latest/download redirect, which
  // is exactly the release just skipped — the manifest under it would then be installed unverified.
  it('never reports no-newer when the only newer releases were skipped as mismatches', async () => {
    respondWithAtom(['v1.4.3', 'v1.4.2', 'v1.4.1'], [], [], [], {
      'v1.4.3': '1.4.9',
      'v1.4.2': '1.4.197-swaplabs.202609241530'
    })
    const { fetchNewerReleaseTagsWithReadiness } = await import('./updater-prerelease-feed')

    expect(await fetchNewerReleaseTagsWithReadiness('1.4.1', 1)).toEqual({
      tags: [],
      state: 'not-ready',
      lastGoodTag: 'v1.4.1'
    })

    // Without a verified older tag in the window there is nothing safe to pin either.
    respondWithAtom(['v1.4.3'], [], [], [], { 'v1.4.3': '1.4.9' })
    expect(await fetchNewerReleaseTagsWithReadiness('1.4.1', 1)).toEqual({
      tags: [],
      state: 'not-ready'
    })
  })

  it('probes a bounded manifest window concurrently', async () => {
    const feedTags = [
      'v1.4.8-rc.0',
      'v1.4.7-rc.0',
      'v1.4.6-rc.0',
      'v1.4.5-rc.0',
      'v1.4.4-rc.0',
      'v1.4.3-rc.0',
      'v1.4.2-rc.0',
      'v1.4.1-rc.0'
    ]
    const manifestUrls: string[] = []
    const manifestResolvers: (() => void)[] = []

    netFetchMock.mockImplementation((url: string) => {
      if (url === 'https://github.com/stablyai/orca/releases.atom') {
        return Promise.resolve({
          ok: true,
          text: () => Promise.resolve(buildAtomFeed(feedTags))
        })
      }

      manifestUrls.push(url)
      return new Promise((resolve) => {
        manifestResolvers.push(() => {
          resolve({ ok: false, text: () => Promise.resolve('') })
        })
      })
    })

    const { fetchNewerReleaseTags } = await import('./updater-prerelease-feed')
    const result = fetchNewerReleaseTags('1.4.0-rc.0', 2)

    await vi.waitFor(() => {
      expect(manifestUrls).toHaveLength(6)
    })
    expect(manifestResolvers).toHaveLength(6)

    for (const resolveManifest of manifestResolvers) {
      resolveManifest()
    }

    await expect(result).resolves.toEqual([])
    expect(netFetchMock).toHaveBeenCalledTimes(7)
  })
})

type ForkRelease = {
  tag: string
  title: string
  manifestVersion?: string
  missingManifest?: boolean
}

/**
 * A fork repo's feed: tags are git labels (`swaplabs-v<base>+<delta>`), so the
 * version must come from the title or the manifest, never the tag.
 */
function respondWithForkFeed(releases: ForkRelease[], upstreamTags: string[] = []): void {
  const byTag = new Map(releases.map((release) => [release.tag, release]))
  netFetchMock.mockImplementation((url: string, init?: { method?: string }) => {
    if (url === 'https://github.com/SwapLabsInc/orca/releases.atom') {
      const entries = releases
        .map(
          ({ tag, title }) =>
            `<entry><link rel="alternate" type="text/html" href="https://github.com/SwapLabsInc/orca/releases/tag/${tag}"/><title>${title}</title></entry>`
        )
        .join('')
      return Promise.resolve({ ok: true, text: () => Promise.resolve(`<feed>${entries}</feed>`) })
    }
    if (url === 'https://github.com/stablyai/orca/releases.atom') {
      return Promise.resolve({ ok: true, text: () => Promise.resolve(buildAtomFeed(upstreamTags)) })
    }
    const manifestMatch = url.match(
      /^https:\/\/github\.com\/(SwapLabsInc|stablyai)\/orca\/releases\/download\/([^/]+)\/latest(?:-[a-z]+)?\.yml$/
    )
    if (manifestMatch) {
      const tag = decodeURIComponent(manifestMatch[2])
      const release = byTag.get(tag)
      if (manifestMatch[1] === 'SwapLabsInc' && (!release || release.missingManifest)) {
        return Promise.resolve({ ok: false, status: 404, text: () => Promise.resolve('') })
      }
      // Why the title's version: fork tags are git labels, and the pipeline stamps the manifest with the same version it titles the release with.
      const version = release?.manifestVersion ?? release?.title.split(/[\s•]+/)[0] ?? tag
      return Promise.resolve({
        ok: true,
        status: 200,
        text: () =>
          Promise.resolve(
            [
              `version: ${version}`,
              'files:',
              `  - url: Orca-${version}.AppImage`,
              '    sha512: t'
            ].join('\n')
          )
      })
    }
    if (init?.method === 'HEAD') {
      return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve('') })
    }
    return Promise.resolve({ ok: false, text: () => Promise.resolve('') })
  })
}

describe('fetchNewerReleaseTag across release sources', () => {
  beforeEach(() => {
    vi.resetModules()
    netFetchMock.mockReset()
    netRequestMock.mockReset()
    installNetRequestFetchAdapter(netRequestMock, netFetchMock)
    setReleaseSourcesLiteralForTest(FORK_RELEASE_SOURCES_LITERAL)
  })

  afterEach(() => {
    setReleaseSourcesLiteralForTest(null)
    setPlatformForTest(ORIGINAL_PLATFORM)
  })

  async function loadFeed() {
    const { fetchNewerReleaseTagsWithReadiness } = await import('./updater-prerelease-feed')
    const { getReleaseSource } = await import('../shared/release-sources')
    return { fetchNewerReleaseTagsWithReadiness, swaplabs: getReleaseSource('swaplabs')! }
  }

  it('reads the atom feed and download base of the given source', async () => {
    respondWithForkFeed([
      {
        tag: 'swaplabs-v1.4.197+resume.2',
        title: '1.4.197-swaplabs.202609241600.resume.2 • 02 • Sep 24'
      },
      {
        tag: 'swaplabs-v1.4.197+resume.1',
        title: '1.4.197-swaplabs.202609241530.resume.1 • 01 • Sep 24'
      }
    ])
    const { fetchNewerReleaseTagsWithReadiness, swaplabs } = await loadFeed()

    const result = await fetchNewerReleaseTagsWithReadiness(
      '1.4.197-swaplabs.202609241530.resume.1',
      2,
      { source: swaplabs }
    )

    // Two tags: the newest newer plus the bounded fallback candidate behind it.
    expect(result).toEqual({
      tags: ['swaplabs-v1.4.197+resume.2', 'swaplabs-v1.4.197+resume.1'],
      state: 'ready'
    })
    const urls = netFetchMock.mock.calls.map(([url]) => String(url))
    expect(urls[0]).toBe('https://github.com/SwapLabsInc/orca/releases.atom')
    expect(urls).toContainEqual(
      expect.stringMatching(
        /^https:\/\/github\.com\/SwapLabsInc\/orca\/releases\/download\/swaplabs-v1\.4\.197%2Bresume\.2\/latest(?:-[a-z]+)?\.yml$/
      )
    )
    expect(urls.some((url) => url.includes('stablyai'))).toBe(false)
  })

  it('reads a version the title omits from the release manifest', async () => {
    respondWithForkFeed([
      {
        tag: 'swaplabs-v1.4.197+resume.3',
        title: 'SwapLabs build 3',
        manifestVersion: '1.4.197-swaplabs.202609241700.resume.3'
      },
      { tag: 'swaplabs-v1.4.197+resume.2', title: '1.4.197-swaplabs.202609241600.resume.2' }
    ])
    const { fetchNewerReleaseTagsWithReadiness, swaplabs } = await loadFeed()

    const result = await fetchNewerReleaseTagsWithReadiness(
      '1.4.197-swaplabs.202609241600.resume.2',
      1,
      { source: swaplabs }
    )

    expect(result).toEqual({ tags: ['swaplabs-v1.4.197+resume.3'], state: 'ready' })
    // The manifest fetched to learn the version is not fetched again for readiness.
    const manifestFetches = netFetchMock.mock.calls.filter(([url]) =>
      /swaplabs-v1\.4\.197%2Bresume\.3\/latest(?:-[a-z]+)?\.yml$/.test(String(url))
    )
    expect(manifestFetches).toHaveLength(1)
  })

  // Why: a fork title can be edited by hand; the manifest, not the title, decides what installs.
  it('skips a source release whose manifest names another build or another source', async () => {
    respondWithForkFeed([
      {
        tag: 'swaplabs-v1.4.197+resume.3',
        title: '1.4.197-swaplabs.202609241700.resume.3',
        manifestVersion: '1.4.197'
      },
      {
        tag: 'swaplabs-v1.4.197+resume.2',
        title: '1.4.197-swaplabs.202609241600.resume.2',
        manifestVersion: '1.4.197-swaplabs.202609241559.resume.2'
      },
      { tag: 'swaplabs-v1.4.197+resume.1', title: '1.4.197-swaplabs.202609241530.resume.1' }
    ])
    const { fetchNewerReleaseTagsWithReadiness, swaplabs } = await loadFeed()

    expect(
      await fetchNewerReleaseTagsWithReadiness('1.4.197-swaplabs.202609241500', 2, {
        source: swaplabs
      })
    ).toEqual({ tags: ['swaplabs-v1.4.197+resume.1'], state: 'ready' })
    // Why not-ready: every newer release was skipped, and the running build's own tag is the
    // verified feed that answers, rather than a fallback that could serve the skipped one.
    expect(
      await fetchNewerReleaseTagsWithReadiness('1.4.197-swaplabs.202609241530.resume.1', 2, {
        source: swaplabs
      })
    ).toEqual({ tags: [], state: 'not-ready', lastGoodTag: 'swaplabs-v1.4.197+resume.1' })
  })

  // Why: the feed is in publish order, so a build re-published or cut out of sequence can sit
  // below an older titled one; a version-order cutoff would have skipped the newest build.
  it('probes every untitled entry once, wherever the feed lists it', async () => {
    respondWithForkFeed([
      { tag: 'swaplabs-v1.4.197+resume.3', title: '1.4.197-swaplabs.202609241650.resume.3' },
      {
        tag: 'swaplabs-v1.4.197+resume.4',
        title: 'SwapLabs build 4',
        manifestVersion: '1.4.197-swaplabs.202609241700.resume.4'
      },
      { tag: 'swaplabs-v1.4.197+resume.2', title: '1.4.197-swaplabs.202609241600.resume.2' },
      {
        tag: 'swaplabs-v1.4.197+resume.1',
        title: 'SwapLabs build 1',
        manifestVersion: '1.4.197-swaplabs.202609241530.resume.1'
      }
    ])
    const { fetchNewerReleaseTagsWithReadiness, swaplabs } = await loadFeed()

    expect(
      await fetchNewerReleaseTagsWithReadiness('1.4.197-swaplabs.202609241600.resume.2', 2, {
        source: swaplabs
      })
    ).toEqual({
      tags: ['swaplabs-v1.4.197+resume.4', 'swaplabs-v1.4.197+resume.3'],
      state: 'ready'
    })
    // Each manifest is read once: the version pass and the readiness pass share probes.
    const fetchedTags = netFetchMock.mock.calls
      .map(([url]) => String(url))
      .filter((url) => /\/latest(?:-[a-z]+)?\.yml$/.test(url))
      .map((url) => decodeURIComponent(url.split('/')[7]))
    expect(fetchedTags).toContain('swaplabs-v1.4.197+resume.4')
    expect(fetchedTags).toContain('swaplabs-v1.4.197+resume.1')
    expect(new Set(fetchedTags).size).toBe(fetchedTags.length)
  })

  it('bounds untitled-entry probes to the candidate budget, newest published first', async () => {
    const releases = Array.from({ length: 8 }, (_, index) => {
      const delta = 8 - index
      return {
        tag: `swaplabs-v1.4.197+resume.${delta}`,
        title: `SwapLabs build ${delta}`,
        manifestVersion: `1.4.197-swaplabs.2026092417${String(delta).padStart(2, '0')}.resume.${delta}`
      }
    })
    respondWithForkFeed(releases)
    const { fetchNewerReleaseTagsWithReadiness, swaplabs } = await loadFeed()

    expect(
      await fetchNewerReleaseTagsWithReadiness('1.4.197-swaplabs.202609241600', 2, {
        source: swaplabs
      })
    ).toEqual({
      tags: ['swaplabs-v1.4.197+resume.8', 'swaplabs-v1.4.197+resume.7'],
      state: 'ready'
    })
    const fetchedTags = netFetchMock.mock.calls
      .map(([url]) => String(url))
      .filter((url) => /\/latest(?:-[a-z]+)?\.yml$/.test(url))
      .map((url) => decodeURIComponent(url.split('/')[7]))
    expect(fetchedTags).toHaveLength(6)
    expect(fetchedTags).not.toContain('swaplabs-v1.4.197+resume.2')
    expect(fetchedTags).not.toContain('swaplabs-v1.4.197+resume.1')
  })

  // Why: a pinned jump trusts nothing but the manifest under the tag it was given.
  it('verifies a tag by what its manifest installs', async () => {
    respondWithForkFeed([
      { tag: 'swaplabs-v1.4.197+resume.2', title: '1.4.197-swaplabs.202609241600.resume.2' },
      { tag: 'swaplabs-v1.4.197+resume.3', title: 'SwapLabs build 3', manifestVersion: '1.4.197' },
      { tag: 'swaplabs-v1.4.197+resume.4', title: 'SwapLabs build 4', missingManifest: true }
    ])
    const { verifyReleaseTagManifest } = await import('./updater-prerelease-feed')
    const { swaplabs } = await loadFeed()
    const forkTarget = (tag: string, version: string) => ({ tag, version, repo: swaplabs.repo })

    await expect(
      verifyReleaseTagManifest(
        forkTarget('swaplabs-v1.4.197+resume.2', '1.4.197-swaplabs.202609241600.resume.2'),
        swaplabs
      )
    ).resolves.toEqual({ kind: 'ready' })
    // A title edited by hand: the manifest still names the build that was uploaded.
    await expect(
      verifyReleaseTagManifest(
        forkTarget('swaplabs-v1.4.197+resume.2', '1.4.197-swaplabs.202609241601.resume.2'),
        swaplabs
      )
    ).resolves.toEqual({
      kind: 'mismatch',
      manifestVersion: '1.4.197-swaplabs.202609241600.resume.2'
    })
    // An upstream build uploaded under a fork tag.
    await expect(
      verifyReleaseTagManifest(
        forkTarget('swaplabs-v1.4.197+resume.3', '1.4.197-swaplabs.202609241700.resume.3'),
        swaplabs
      )
    ).resolves.toEqual({ kind: 'mismatch', manifestVersion: '1.4.197' })
    await expect(
      verifyReleaseTagManifest(
        forkTarget('swaplabs-v1.4.197+resume.4', '1.4.197-swaplabs.202609241800.resume.4'),
        swaplabs
      )
    ).resolves.toEqual({ kind: 'not-ready' })

    netFetchMock.mockRejectedValue(new Error('network down'))
    await expect(
      verifyReleaseTagManifest(
        forkTarget('swaplabs-v1.4.197+resume.2', '1.4.197-swaplabs.202609241600.resume.2'),
        swaplabs
      )
    ).resolves.toEqual({ kind: 'unavailable' })
  })

  // Why: hourly, daily and adhoc tags exist only in their own repos, and the source's main repo
  // 404s them — every dev-channel pin used to be refused as having no installable build.
  it("verifies a dev-channel tag in the repo its pin reads, not the source's main one", async () => {
    setPlatformForTest('darwin')
    const tag = 'v1.4.160-hourly.202607281400'
    const manifestUrls: string[] = []
    netFetchMock.mockImplementation((url: string, init?: { method?: string }) => {
      if (/\/latest(?:-[a-z0-9]+)?\.yml$/.test(url)) {
        manifestUrls.push(url)
        if (!url.startsWith('https://github.com/stablyai/orca-hourly/releases/download/')) {
          return Promise.resolve({ ok: false, status: 404, text: () => Promise.resolve('') })
        }
        return Promise.resolve({
          ok: true,
          status: 200,
          text: () => Promise.resolve(buildManifest(tag))
        })
      }
      if (init?.method === 'HEAD') {
        return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve('') })
      }
      return Promise.resolve({ ok: false, status: 503, text: () => Promise.resolve('') })
    })
    const { verifyReleaseTagManifest } = await import('./updater-prerelease-feed')
    const { PRIMARY_RELEASE_SOURCE } = await import('../shared/release-sources')

    await expect(
      verifyReleaseTagManifest(
        { tag, version: '1.4.160-hourly.202607281400', repo: 'stablyai/orca-hourly' },
        PRIMARY_RELEASE_SOURCE
      )
    ).resolves.toEqual({ kind: 'ready' })
    expect(manifestUrls).toEqual([
      `https://github.com/stablyai/orca-hourly/releases/download/${tag}/latest-mac.yml`
    ])
  })

  it('reports no-newer for a source build whose feed holds only older stamps', async () => {
    respondWithForkFeed([
      { tag: 'swaplabs-v1.4.197+resume.1', title: '1.4.197-swaplabs.202609241530.resume.1' }
    ])
    const { fetchNewerReleaseTagsWithReadiness, swaplabs } = await loadFeed()

    expect(
      await fetchNewerReleaseTagsWithReadiness('1.4.197-swaplabs.202609241600', 2, {
        source: swaplabs,
        includePrerelease: false
      })
    ).toEqual({ tags: [], state: 'no-newer' })
  })

  it('orders an rc-based fork build by stamp, not by the rc tail', async () => {
    respondWithForkFeed([
      { tag: 'swaplabs-v1.4.198-rc.1+x', title: '1.4.198-rc.1.swaplabs.202609251200' },
      { tag: 'swaplabs-v1.4.197+y', title: '1.4.197-swaplabs.202609241600' }
    ])
    const { fetchNewerReleaseTagsWithReadiness, swaplabs } = await loadFeed()

    expect(
      await fetchNewerReleaseTagsWithReadiness('1.4.197-swaplabs.202609241600', 1, {
        source: swaplabs
      })
    ).toEqual({ tags: ['swaplabs-v1.4.198-rc.1+x'], state: 'ready' })
  })

  // Why: `swaplabs` sorts above `rc`, so a fork tag in the main repo would
  // otherwise be offered to every RC user as the newest prerelease.
  it('never yields a source-stamped tag to a primary check even when the feed lists one', async () => {
    respondWithAtom(['v1.4.197-swaplabs.202609241530', 'v1.4.197-rc.2', 'v1.4.196'])
    const { fetchNewerReleaseTagsWithReadiness } = await import('./updater-prerelease-feed')

    expect(await fetchNewerReleaseTagsWithReadiness('1.4.197-rc.1', 2)).toEqual({
      tags: ['v1.4.197-rc.2', 'v1.4.196'],
      state: 'ready'
    })
    expect(await fetchNewerReleaseTagsWithReadiness('1.4.197-rc.2', 2)).toEqual({
      tags: [],
      state: 'no-newer'
    })
  })

  it('matches only tag links of the requested repo', async () => {
    netFetchMock.mockImplementation((url: string) =>
      Promise.resolve({
        ok: true,
        status: 200,
        text: () =>
          Promise.resolve(
            url.includes('SwapLabsInc')
              ? '<feed><entry><link href="https://github.com/stablyai/orca/releases/tag/v9.9.9"/><title>9.9.9-swaplabs.202609241530</title></entry></feed>'
              : ''
          )
      })
    )
    const { fetchNewerReleaseTagsWithReadiness, swaplabs } = await loadFeed()

    expect(
      await fetchNewerReleaseTagsWithReadiness('1.4.197-swaplabs.202609241530', 1, {
        source: swaplabs
      })
    ).toEqual({ tags: [], state: 'no-newer' })
  })
})
