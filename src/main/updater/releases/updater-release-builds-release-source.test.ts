import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PRIMARY_RELEASE_SOURCE } from '../../../shared/release-sources'
import {
  FORK_RELEASE_SOURCES_LITERAL,
  setReleaseSourcesLiteralForTest
} from '../../../shared/release-sources.fixture'

const fetchMock = vi.fn()
vi.mock('electron', () => ({ net: { fetch: (...args: unknown[]) => fetchMock(...args) } }))

/** LOCAL: what the running build's installer applies to, as the activation module would answer. */
const installerSource = vi.hoisted((): { value: unknown } => ({ value: null }))
vi.mock('../mac-self-update/mac-self-update-activation', () => ({
  getMacSelfUpdateInstallerSourceFor: async () => installerSource.value
}))

vi.mock('./updater-release-api-token', () => ({
  resolveReleaseApiToken: async () => null,
  rejectReleaseApiToken: () => {}
}))

function jsonResponse(body: unknown) {
  return { ok: true, status: 200, headers: new Headers(), json: () => Promise.resolve(body) }
}

const release = (tag: string, extra: Record<string, unknown> = {}) => ({
  tag_name: tag,
  draft: false,
  published_at: '2026-07-28T14:00:00Z',
  html_url: `https://github.com/stablyai/orca/releases/tag/${tag}`,
  assets: [{ name: 'latest-linux.yml' }, { name: 'orca-linux.AppImage' }],
  ...extra
})

describe('listReleaseBuilds for another release source', () => {
  /** Re-evaluates the module graph under a two-source registry, as a fork build would run it. */
  async function loadForkModule() {
    setReleaseSourcesLiteralForTest(FORK_RELEASE_SOURCES_LITERAL)
    vi.resetModules()
    const module = await import('./updater-release-builds')
    const { getReleaseSource } = await import('../../../shared/release-sources')
    return { ...module, swaplabs: getReleaseSource('swaplabs')! }
  }

  beforeEach(() => {
    fetchMock.mockReset()
    installerSource.value = null
  })

  afterEach(() => {
    setReleaseSourcesLiteralForTest(null)
    vi.resetModules()
  })

  // LOCAL: a fork macOS release has no latest-mac.yml; the installer reads the slice's manifest.
  it('lists a fork macOS release by its self-update manifest for the running slice', async () => {
    const { listReleaseBuilds, swaplabs } = await loadForkModule()
    const forkRelease = {
      tag_name: 'swaplabs-v1.4.197+202609251200',
      name: '1.4.197-swaplabs.202609251200 • Sep 25 • abc1234',
      draft: false,
      published_at: '2026-09-25T12:00:00Z',
      html_url: 'https://github.com/SwapLabsInc/orca/releases/tag/swaplabs-v1.4.197%2B202609251200',
      assets: [
        { name: 'orca-macos-arm64.zip' },
        { name: 'swaplabs-update-mac-arm64.json' },
        { name: 'swaplabs-update-mac-arm64.json.sig' },
        { name: 'latest-linux.yml' }
      ]
    }
    fetchMock.mockResolvedValue(jsonResponse([forkRelease]))

    const withSelfUpdate = await listReleaseBuilds('stable', 'darwin', swaplabs, 'arm64', swaplabs)
    expect(withSelfUpdate.map((build) => build.version)).toEqual(['1.4.197-swaplabs.202609251200'])
    // The other slice has no manifest of its own, and without the installer nothing on macOS does.
    await expect(listReleaseBuilds('stable', 'darwin', swaplabs, 'x64', swaplabs)).resolves.toEqual(
      []
    )
    await expect(listReleaseBuilds('stable', 'darwin', swaplabs, 'arm64', null)).resolves.toEqual(
      []
    )
  })

  // LOCAL: a build the installer cannot act for installs by hand, which needs the slice's DMG.
  it('lists a fork macOS release by its DMG when the installer does not apply to it', async () => {
    const { listReleaseBuilds, swaplabs } = await loadForkModule()
    const dmgOnly = {
      tag_name: 'swaplabs-v1.4.197+202609251200',
      name: '1.4.197-swaplabs.202609251200 • Sep 25 • abc1234',
      draft: false,
      published_at: '2026-09-25T12:00:00Z',
      html_url: 'https://github.com/SwapLabsInc/orca/releases/tag/swaplabs-v1.4.197%2B202609251200',
      assets: [{ name: 'orca-macos-arm64.dmg' }, { name: 'orca-macos-x64.dmg' }]
    }
    const sliceOnly = {
      tag_name: 'swaplabs-v1.4.197+202609261200',
      name: '1.4.197-swaplabs.202609261200 • Sep 26 • def5678',
      draft: false,
      published_at: '2026-09-26T12:00:00Z',
      html_url: 'https://github.com/SwapLabsInc/orca/releases/tag/swaplabs-v1.4.197%2B202609261200',
      assets: [
        { name: 'orca-macos-arm64.zip' },
        { name: 'swaplabs-update-mac-arm64.json' },
        { name: 'swaplabs-update-mac-arm64.json.sig' }
      ]
    }
    fetchMock.mockResolvedValue(jsonResponse([sliceOnly, dmgOnly]))

    const byHand = await listReleaseBuilds('stable', 'darwin', swaplabs, 'arm64', null)
    expect(byHand.map((build) => build.version)).toEqual(['1.4.197-swaplabs.202609251200'])
    expect(byHand[0].installerUrl).toBe(
      'https://github.com/SwapLabsInc/orca/releases/download/swaplabs-v1.4.197%2B202609251200/orca-macos-arm64.dmg'
    )
    // With the installer active the same list is the slice's, which the DMG-only release lacks.
    const inApp = await listReleaseBuilds('stable', 'darwin', swaplabs, 'arm64', swaplabs)
    expect(inApp.map((build) => build.version)).toEqual(['1.4.197-swaplabs.202609261200'])
    // The primary source keeps the platform rule either way: no DMG requirement, no slice.
    await expect(
      listReleaseBuilds('stable', 'darwin', PRIMARY_RELEASE_SOURCE, 'arm64', null)
    ).resolves.toEqual([])
  })

  it('keys the default listing on what the running build can install', async () => {
    const { listReleaseBuilds, swaplabs } = await loadForkModule()
    const dmgOnly = {
      tag_name: 'swaplabs-v1.4.197+202609251200',
      name: '1.4.197-swaplabs.202609251200 • Sep 25 • abc1234',
      draft: false,
      published_at: '2026-09-25T12:00:00Z',
      html_url: 'https://github.com/SwapLabsInc/orca/releases/tag/swaplabs-v1.4.197%2B202609251200',
      assets: [{ name: 'orca-macos-arm64.dmg' }]
    }
    fetchMock.mockResolvedValue(jsonResponse([dmgOnly]))

    await expect(
      listReleaseBuilds('stable', 'darwin', swaplabs, 'arm64').then((builds) =>
        builds.map((build) => build.version)
      )
    ).resolves.toEqual(['1.4.197-swaplabs.202609251200'])
    installerSource.value = swaplabs
    await expect(listReleaseBuilds('stable', 'darwin', swaplabs, 'arm64')).resolves.toEqual([])
  })

  // LOCAL: the installer fetches the zip, manifest and signature; a partial upload would 404.
  it('hides a fork macOS release until its zip, manifest and signature are all attached', async () => {
    const { listReleaseBuilds, swaplabs } = await loadForkModule()
    const sliceAssets = [
      'orca-macos-arm64.zip',
      'swaplabs-update-mac-arm64.json',
      'swaplabs-update-mac-arm64.json.sig'
    ]
    const forkRelease = (assetNames: string[]) => ({
      tag_name: 'swaplabs-v1.4.197+202609251200',
      name: '1.4.197-swaplabs.202609251200 • Sep 25 • abc1234',
      draft: false,
      published_at: '2026-09-25T12:00:00Z',
      html_url: 'https://github.com/SwapLabsInc/orca/releases/tag/swaplabs-v1.4.197%2B202609251200',
      assets: assetNames.map((name) => ({ name }))
    })

    for (const missing of sliceAssets) {
      fetchMock.mockResolvedValue(
        jsonResponse([forkRelease(sliceAssets.filter((name) => name !== missing))])
      )
      await expect(
        listReleaseBuilds('stable', 'darwin', swaplabs, 'arm64', swaplabs),
        `without ${missing}`
      ).resolves.toEqual([])
    }
    fetchMock.mockResolvedValue(jsonResponse([forkRelease(sliceAssets)]))
    const complete = await listReleaseBuilds('stable', 'darwin', swaplabs, 'arm64', swaplabs)
    expect(complete.map((build) => build.version)).toEqual(['1.4.197-swaplabs.202609251200'])
  })

  // LOCAL: with the installer active nothing else installs in-app, so an incomplete slice hides.
  it.each([
    ['its DMG', ['orca-macos-arm64.dmg']],
    ['a stray latest-mac.yml', ['latest-mac.yml', 'orca-macos-arm64.dmg']]
  ])(
    'hides a fork macOS release with an incomplete slice even when it carries %s',
    async (_label, otherAssets) => {
      const { listReleaseBuilds, swaplabs } = await loadForkModule()
      const sliceAssets = [
        'orca-macos-arm64.zip',
        'swaplabs-update-mac-arm64.json',
        'swaplabs-update-mac-arm64.json.sig'
      ]
      const forkRelease = (assetNames: string[]) => ({
        tag_name: 'swaplabs-v1.4.197+202609251200',
        name: '1.4.197-swaplabs.202609251200 • Sep 25 • abc1234',
        draft: false,
        published_at: '2026-09-25T12:00:00Z',
        html_url:
          'https://github.com/SwapLabsInc/orca/releases/tag/swaplabs-v1.4.197%2B202609251200',
        assets: assetNames.map((name) => ({ name }))
      })

      for (const missing of sliceAssets) {
        fetchMock.mockResolvedValue(
          jsonResponse([
            forkRelease([...otherAssets, ...sliceAssets.filter((name) => name !== missing)])
          ])
        )
        await expect(
          listReleaseBuilds('stable', 'darwin', swaplabs, 'arm64', swaplabs),
          `without ${missing}`
        ).resolves.toEqual([])
      }
      fetchMock.mockResolvedValue(jsonResponse([forkRelease([...otherAssets, ...sliceAssets])]))
      const complete = await listReleaseBuilds('stable', 'darwin', swaplabs, 'arm64', swaplabs)
      expect(complete.map((build) => build.version)).toEqual(['1.4.197-swaplabs.202609251200'])
    }
  )

  // Why the title: fork tags are git labels, and the REST reply carries no manifest.
  it('lists a source repo, reading versions from titles, newest stamp first', async () => {
    const { listReleaseBuilds, swaplabs } = await loadForkModule()
    fetchMock.mockResolvedValue(
      jsonResponse([
        release('swaplabs-v1.4.197+resume.1', {
          name: '1.4.197-swaplabs.202609241530.resume.1 • 01 • Sep 24, 3:30PM • abc1234',
          html_url: 'https://github.com/SwapLabsInc/orca/releases/tag/swaplabs-v1.4.197+resume.1'
        }),
        release('swaplabs-v1.4.198-rc.1+resume.2', {
          name: '1.4.198-rc.1.swaplabs.202609251200.resume.2 • 02',
          html_url:
            'https://github.com/SwapLabsInc/orca/releases/tag/swaplabs-v1.4.198-rc.1+resume.2'
        }),
        release('swaplabs-untitled', { name: 'SwapLabs build without a version' }),
        release('v1.4.197', { name: '1.4.197' })
      ])
    )

    const builds = await listReleaseBuilds('stable', 'linux', swaplabs, 'x64')

    expect(fetchMock.mock.calls[0][0]).toBe(
      'https://api.github.com/repos/SwapLabsInc/orca/releases?per_page=100'
    )
    expect(builds.map((build) => [build.tag, build.version, build.channel])).toEqual([
      ['swaplabs-v1.4.198-rc.1+resume.2', '1.4.198-rc.1.swaplabs.202609251200.resume.2', 'stable'],
      ['swaplabs-v1.4.197+resume.1', '1.4.197-swaplabs.202609241530.resume.1', 'stable']
    ])
    expect(builds[1].installerUrl).toBe(
      'https://github.com/SwapLabsInc/orca/releases/download/swaplabs-v1.4.197%2Bresume.1/orca-linux.AppImage'
    )
  })

  it('keeps a stray fork build out of the primary stable list', async () => {
    const { listReleaseBuilds } = await loadForkModule()
    fetchMock.mockResolvedValue(
      jsonResponse([release('v1.4.197-swaplabs.202609241530'), release('v1.4.196')])
    )

    const builds = await listReleaseBuilds('stable', 'linux')

    expect(builds.map((build) => build.version)).toEqual(['1.4.196'])
  })

  it('resolves a fork target from the version the picker listed', async () => {
    const { resolveTargetBuild, swaplabs } = await loadForkModule()

    expect(
      resolveTargetBuild(
        'stable',
        'swaplabs-v1.4.197+resume.1',
        swaplabs,
        '1.4.197-swaplabs.202609241530.resume.1'
      )
    ).toEqual({
      tag: 'swaplabs-v1.4.197+resume.1',
      version: '1.4.197-swaplabs.202609241530.resume.1',
      repo: 'SwapLabsInc/orca',
      feedUrl: 'https://github.com/SwapLabsInc/orca/releases/download/swaplabs-v1.4.197%2Bresume.1'
    })
    expect(() => resolveTargetBuild('stable', 'swaplabs-v1.4.197+resume.1', swaplabs)).toThrow(
      /not a valid release tag for SwapLabs/
    )
    // A primary version handed to the fork source is not one of its builds.
    expect(() => resolveTargetBuild('stable', 'v1.4.197', swaplabs)).toThrow(/for SwapLabs/)
  })
})
