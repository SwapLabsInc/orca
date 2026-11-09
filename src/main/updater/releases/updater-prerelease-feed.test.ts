import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setHostSliceForTest } from '../../updater-host-slice.fixture'
import { installNetRequestFetchAdapter } from '../testing/updater-net-request.fixture'
import {
  FORK_RELEASE_SOURCES_LITERAL,
  setReleaseSourcesLiteralForTest
} from '../../../shared/release-sources.fixture'

const ORIGINAL_PLATFORM = process.platform
const ORIGINAL_ARCH = process.arch

const { netFetchMock, netRequestMock } = vi.hoisted(() => ({
  netFetchMock: vi.fn(),
  netRequestMock: vi.fn()
}))

vi.mock('electron', () => ({
  net: { fetch: netFetchMock, request: netRequestMock }
}))

function buildAtomFeed(tags: string[], updatedAt: Record<string, string> = {}): string {
  const entries = tags
    .map(
      (tag) =>
        `<entry>${updatedAt[tag] ? `<updated>${updatedAt[tag]}</updated>` : ''}<link rel="alternate" type="text/html" href="https://github.com/stablyai/orca/releases/tag/${tag}"/><title>${tag}</title></entry>`
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
  updatedAt: Record<string, string> = {},
  manifestVersions: Record<string, string | null> = {}
): void {
  const missingManifests = new Set(missingManifestTags)
  const missingAssets = new Set(missingAssetTags)
  const unavailableManifests = new Set(unavailableManifestTags)
  netFetchMock.mockImplementation((url: string, init?: { method?: string }) => {
    if (url === 'https://github.com/stablyai/orca/releases.atom') {
      return Promise.resolve({
        ok: true,
        text: () => Promise.resolve(buildAtomFeed(tags, updatedAt))
      })
    }

    const manifestMatch = url.match(/\/releases\/download\/([^/]+)\/latest(?:-[a-z0-9-]+)?\.yml$/)
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

function setArchForTest(arch: NodeJS.Architecture): void {
  Object.defineProperty(process, 'arch', { value: arch })
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
    setArchForTest(ORIGINAL_ARCH)
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

  it('does not return the current tag as the primary update when newer manifests are missing', async () => {
    respondWithAtom(['v1.4.1-rc.3', 'v1.4.1-rc.2', 'v1.4.1-rc.1'], ['v1.4.1-rc.3', 'v1.4.1-rc.2'])

    const { fetchNewerReleaseTag, fetchNewerReleaseTags } =
      await import('./updater-prerelease-feed')

    expect(await fetchNewerReleaseTag('1.4.1-rc.1')).toBeNull()
    expect(await fetchNewerReleaseTags('1.4.1-rc.1', 2)).toEqual([])
  })

  // Why: electron-updater installs what the manifest names, so it must name the advertised version.
  it('never offers a tag whose manifest names a version other than the advertised one', async () => {
    respondWithAtom(['v1.4.2', 'v1.4.1'], [], [], [], {}, { 'v1.4.2': '1.4.1' })
    const { fetchNewerReleaseTag, fetchNewerReleaseTagsWithReadiness } =
      await import('./updater-prerelease-feed')

    expect(await fetchNewerReleaseTag('1.4.0')).toBe('v1.4.1')

    respondWithAtom(['v1.4.2', 'v1.4.1'], [], [], [], {}, { 'v1.4.2': null })
    expect(await fetchNewerReleaseTagsWithReadiness('1.4.0', 1)).toEqual({
      tags: [],
      state: 'not-ready',
      lastGoodTag: 'v1.4.1'
    })
  })

  // Why: no-newer pins /releases/latest/download, which serves the very release just skipped.
  it('never reports no-newer when the only newer releases were skipped as mismatches', async () => {
    respondWithAtom(
      ['v1.4.3', 'v1.4.2', 'v1.4.1'],
      [],
      [],
      [],
      {},
      {
        'v1.4.3': '1.4.9',
        'v1.4.2': '1.4.197-swaplabs.202609241530'
      }
    )
    const { fetchNewerReleaseTagsWithReadiness } = await import('./updater-prerelease-feed')

    expect(await fetchNewerReleaseTagsWithReadiness('1.4.1', 1)).toEqual({
      tags: [],
      state: 'not-ready',
      lastGoodTag: 'v1.4.1'
    })

    // Without a verified older tag in the window there is nothing safe to pin either.
    respondWithAtom(['v1.4.3'], [], [], [], {}, { 'v1.4.3': '1.4.9' })
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

/** A fork repo's feed: tags are git labels, so versions come from titles or manifests. */
function respondWithForkFeed(releases: ForkRelease[], upstreamTags: string[] = []): void {
  const byTag = new Map(releases.map((release) => [release.tag, release]))
  netFetchMock.mockImplementation((url: string, init?: { method?: string }) => {
    if (url === 'https://github.com/SwapLabsInc/orca/releases.atom') {
      const entries = releases
        .map(
          ({ tag, title }) =>
            // Why encoded: GitHub serves the tag percent-encoded in the href (`+` as `%2B`).
            `<entry><link rel="alternate" type="text/html" href="https://github.com/SwapLabsInc/orca/releases/tag/${encodeURIComponent(tag)}"/><title>${title}</title></entry>`
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
  // Why x64: every manifest and asset these cases name is the x64 slice's.
  let restoreHostSlice = (): void => {}

  beforeEach(() => {
    vi.resetModules()
    netFetchMock.mockReset()
    netRequestMock.mockReset()
    installNetRequestFetchAdapter(netRequestMock, netFetchMock)
    setReleaseSourcesLiteralForTest(FORK_RELEASE_SOURCES_LITERAL)
    restoreHostSlice = setHostSliceForTest({ arch: 'x64' })
  })

  afterEach(() => {
    setReleaseSourcesLiteralForTest(null)
    restoreHostSlice()
  })

  async function loadFeed() {
    const { fetchNewerReleaseTagsWithReadiness } = await import('./updater-prerelease-feed')
    const { getReleaseSource } = await import('../../../shared/release-sources')
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

  // Why: the fork feed also lists upstream's bare tags (`v1.4.216`), which carry no fork assets.
  it('decodes feed tags once and never probes a mirrored upstream tag', async () => {
    respondWithForkFeed([
      { tag: 'v1.4.216', title: 'v1.4.216' },
      { tag: 'swaplabs-v1.4.214+202609282117', title: '1.4.214-swaplabs.202609282117 • 7655161' },
      { tag: 'v1.4.215', title: 'v1.4.215' },
      { tag: 'swaplabs-v1.4.214+202609281805', title: '1.4.214-swaplabs.202609281805 • f326ee0' }
    ])
    const { fetchNewerReleaseTagsWithReadiness, swaplabs } = await loadFeed()

    const result = await fetchNewerReleaseTagsWithReadiness('1.4.214-swaplabs.202609281805', 1, {
      source: swaplabs
    })

    expect(result).toEqual({ tags: ['swaplabs-v1.4.214+202609282117'], state: 'ready' })
    const urls = netFetchMock.mock.calls.map(([url]) => String(url))
    expect(urls.some((url) => url.includes('%25'))).toBe(false)
    expect(urls.some((url) => /\/download\/v1\.4\.21[56]\//.test(url))).toBe(false)
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
    // Why not-ready: every newer release was skipped, so the running build's verified tag answers.
    expect(
      await fetchNewerReleaseTagsWithReadiness('1.4.197-swaplabs.202609241530.resume.1', 2, {
        source: swaplabs
      })
    ).toEqual({ tags: [], state: 'not-ready', lastGoodTag: 'swaplabs-v1.4.197+resume.1' })
  })

  // Why: the feed is in publish order, so a newer build can sit below an older titled one.
  it('probes every untitled entry, wherever the feed lists it', async () => {
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
    const fetchedTags = netFetchMock.mock.calls
      .map(([url]) => String(url))
      .filter((url) => /\/latest(?:-[a-z]+)?\.yml$/.test(url))
      .map((url) => decodeURIComponent(url.split('/')[7]))
    expect(fetchedTags).toContain('swaplabs-v1.4.197+resume.4')
    expect(fetchedTags).toContain('swaplabs-v1.4.197+resume.1')
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

  // Why: dev-channel tags exist only in their own repos; the source's main repo 404s them.
  it("verifies a dev-channel tag in the repo its pin reads, not the source's main one", async () => {
    setHostSliceForTest({ platform: 'darwin' })
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
    const { PRIMARY_RELEASE_SOURCE } = await import('../../../shared/release-sources')

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

  // Why: `swaplabs` sorts above `rc`, so a fork tag in the main repo would reach every RC user.
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

describe('fetchNewerReleaseTagsWithReadiness update delay', () => {
  const DAY_MS = 24 * 60 * 60 * 1000
  const NOW = Date.parse('2026-11-02T12:00:00Z')
  const daysAgo = (days: number): string => new Date(NOW - days * DAY_MS).toISOString()
  const delay = { includePrerelease: false, minReleaseAgeMs: 7 * DAY_MS, now: NOW }

  beforeEach(() => {
    vi.resetModules()
    netFetchMock.mockReset()
    netRequestMock.mockReset()
    installNetRequestFetchAdapter(netRequestMock, netFetchMock)
  })

  it('offers the newest release past the delay and reports the newer one it holds', async () => {
    respondWithAtom(['v1.4.3', 'v1.4.2', 'v1.4.1'], [], [], [], {
      'v1.4.3': daysAgo(1),
      'v1.4.2': daysAgo(8),
      'v1.4.1': daysAgo(20)
    })
    const { fetchNewerReleaseTagsWithReadiness } = await import('./updater-prerelease-feed')
    const result = await fetchNewerReleaseTagsWithReadiness('1.4.1', 1, delay)
    expect(result.tags).toEqual(['v1.4.2'])
    expect(result.releaseDelay?.heldRelease).toEqual({
      tag: 'v1.4.3',
      version: '1.4.3',
      releasedAt: NOW - DAY_MS
    })
  })

  it('holds everything when every newer release is inside the delay', async () => {
    respondWithAtom(['v1.4.3', 'v1.4.2'], [], [], [], {
      'v1.4.3': daysAgo(1),
      'v1.4.2': daysAgo(3)
    })
    const { fetchNewerReleaseTagsWithReadiness } = await import('./updater-prerelease-feed')
    const result = await fetchNewerReleaseTagsWithReadiness('1.4.1', 1, delay)
    expect(result).toMatchObject({ tags: [], state: 'no-newer' })
    expect(result.releaseDelay?.heldRelease?.tag).toBe('v1.4.3')
  })

  it('fails closed for releases without a feed timestamp', async () => {
    respondWithAtom(['v1.4.2'])
    const { fetchNewerReleaseTagsWithReadiness } = await import('./updater-prerelease-feed')
    const result = await fetchNewerReleaseTagsWithReadiness('1.4.1', 1, delay)
    expect(result.tags).toEqual([])
    expect(result.releaseDelay?.heldRelease).toEqual({
      tag: 'v1.4.2',
      version: '1.4.2',
      releasedAt: null
    })
  })
})
