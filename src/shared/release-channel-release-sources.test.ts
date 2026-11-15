import { afterEach, describe, expect, it, vi } from 'vitest'
import { findInstallerAssetName, type ReleaseBuild } from './release-channel'
import type * as ReleaseChannelModule from './release-channel.js'
import {
  FORK_RELEASE_SOURCES_LITERAL,
  setReleaseSourcesLiteralForTest
} from './release-sources.fixture'

describe('release installer asset', () => {
  // Why: a release ships one DMG per slice, and the first one listed used to win on every arch.
  it('picks the DMG built for the running architecture, and none without a matching slice', () => {
    const assets = ['latest-mac.yml', 'orca-macos-x64.dmg', 'orca-macos-arm64.dmg']
    expect(findInstallerAssetName('darwin', assets, 'arm64')).toBe('orca-macos-arm64.dmg')
    expect(findInstallerAssetName('darwin', assets, 'x64')).toBe('orca-macos-x64.dmg')
    expect(
      findInstallerAssetName('darwin', ['latest-mac.yml', 'orca-macos-x64.dmg'], 'arm64')
    ).toBeNull()
    expect(findInstallerAssetName('darwin', assets, 'ia32')).toBeNull()
  })

  // Why: the x64 and arm64 AppImages ship side by side; any AppImage used to match on arm64.
  it('picks the AppImage built for the running architecture, and none without a matching slice', () => {
    const assets = [
      'latest-linux.yml',
      'orca-linux.AppImage',
      'latest-linux-arm64.yml',
      'orca-linux-arm64.AppImage'
    ]
    expect(findInstallerAssetName('linux', assets, 'arm64')).toBe('orca-linux-arm64.AppImage')
    expect(findInstallerAssetName('linux', assets, 'x64')).toBe('orca-linux.AppImage')
    expect(
      findInstallerAssetName('linux', ['latest-linux.yml', 'orca-linux.AppImage'], 'arm64')
    ).toBeNull()
    expect(
      findInstallerAssetName(
        'linux',
        ['latest-linux-arm64.yml', 'orca-linux-arm64.AppImage'],
        'x64'
      )
    ).toBeNull()
    expect(findInstallerAssetName('linux', assets, 'ia32')).toBeNull()
  })
})

/** Re-evaluates the channel table against a two-source registry, as a fork build would see it. */
async function loadForkChannels(): Promise<typeof ReleaseChannelModule> {
  vi.resetModules()
  setReleaseSourcesLiteralForTest(FORK_RELEASE_SOURCES_LITERAL)
  return import('./release-channel.js')
}

describe('release channel with a second source', () => {
  afterEach(() => {
    setReleaseSourcesLiteralForTest(null)
    vi.resetModules()
  })

  // Why: the catch-all filed every unknown prerelease under rc, offering fork builds upstream's RC.
  it('classifies a source-stamped version as its source and channel stable, not rc', async () => {
    const fork = await loadForkChannels()

    expect(fork.getVersionChannel('1.4.197-swaplabs.202609241530')).toBe('stable')
    expect(fork.getVersionChannel('1.4.198-rc.1.swaplabs.202609241530.resume.1')).toBe('stable')
    expect(fork.getVersionChannel('1.4.197-rc.3')).toBe('rc')
    expect(fork.getVersionChannel('1.4.197-hourly.202607281400')).toBe('hourly')
    expect(fork.parseSourceBuildStamp('1.4.197-swaplabs.202609241530')?.toISOString()).toBe(
      '2026-09-24T15:30:00.000Z'
    )
    expect(fork.parseSourceBuildStamp('1.4.197-swaplabs.202613241530')).toBeNull()
    expect(fork.parseSourceBuildStamp('1.4.197-hourly.202607281400')).toBeNull()
    expect(fork.parseSourceBuildStamp('1.4.197')).toBeNull()
  })

  it('keeps the dev channels on the primary repo and sends other sources to their own', async () => {
    const fork = await loadForkChannels()

    expect(fork.getReleaseRepoForChannel('stable')).toBe('stablyai/orca')
    expect(fork.getReleaseRepoForChannel('hourly', 'upstream')).toBe('stablyai/orca-hourly')
    expect(fork.getReleaseRepoForChannel('stable', 'swaplabs')).toBe('SwapLabsInc/orca')
    expect(fork.getReleaseRepoForChannel('stable', 'unknown')).toBe('stablyai/orca')
  })

  it('sorts consecutive source builds newest first by stamp, across base versions', async () => {
    const fork = await loadForkChannels()
    const build = (version: string): ReleaseBuild => ({
      tag: `swaplabs-v${version.split('-')[0]}+x`,
      version,
      channel: 'stable',
      name: null,
      publishedAt: null,
      releaseUrl: 'https://github.com/SwapLabsInc/orca/releases',
      installerUrl: null
    })
    const sorted = fork.sortReleaseBuildsNewestFirst([
      build('1.4.197-swaplabs.202609241530.resume.2'),
      build('1.4.198-rc.1.swaplabs.202609240900'),
      build('1.4.197-swaplabs.202609241600')
    ])
    expect(sorted.map((entry) => entry.version)).toEqual([
      '1.4.197-swaplabs.202609241600',
      '1.4.197-swaplabs.202609241530.resume.2',
      '1.4.198-rc.1.swaplabs.202609240900'
    ])
  })

  // Why the listing: fork tags are not `v<version>`, so a derived tag URL would 404.
  it('links release notes to the source repo listing for a source build', async () => {
    const fork = await loadForkChannels()

    expect(fork.getReleaseNotesUrlForVersion('1.4.197-swaplabs.202609241530')).toBe(
      'https://github.com/SwapLabsInc/orca/releases'
    )
    expect(fork.getReleaseNotesUrlForVersion('1.4.197')).toBe(
      'https://github.com/stablyai/orca/releases/tag/v1.4.197'
    )
  })

  // Why Windows too: electron-updater rejects an installer signed by another publisher.
  it('requires a manual install for every macOS and Windows cross-source jump and never on Linux', async () => {
    const fork = await loadForkChannels()
    const manual = (platform: NodeJS.Platform, running: string | null, target: string) =>
      fork.requiresManualInstall({
        platform,
        running: { source: running, channel: 'stable' },
        target: { source: target, channel: 'stable' }
      })

    for (const platform of ['darwin', 'win32'] as const) {
      expect(manual(platform, 'upstream', 'swaplabs')).toBe(true)
      expect(manual(platform, 'swaplabs', 'upstream')).toBe(true)
      expect(manual(platform, null, 'swaplabs')).toBe(true)
      expect(manual(platform, 'upstream', 'upstream')).toBe(false)
    }
    expect(manual('win32', 'swaplabs', 'swaplabs')).toBe(false)
    // LOCAL: Squirrel.Mac refuses a fork bundle (not Developer ID signed); only Orca's installer can.
    expect(manual('darwin', 'swaplabs', 'swaplabs')).toBe(true)
    expect(
      fork.requiresManualInstall({
        platform: 'darwin',
        running: { source: 'swaplabs', channel: 'stable' },
        target: { source: 'swaplabs', channel: 'stable' },
        macSelfUpdate: true
      })
    ).toBe(false)
    expect(
      fork.requiresManualInstall({
        platform: 'darwin',
        running: { source: 'upstream', channel: 'stable' },
        target: { source: 'swaplabs', channel: 'stable' },
        macSelfUpdate: true
      })
    ).toBe(true)
    expect(manual('linux', 'upstream', 'swaplabs')).toBe(false)
    expect(manual('linux', 'swaplabs', 'upstream')).toBe(false)
    expect(manual('linux', null, 'swaplabs')).toBe(false)
    // Windows keeps the dev-channel rule on top: entering a dev channel from a signed build.
    expect(
      fork.requiresManualInstall({
        platform: 'win32',
        running: { source: 'upstream', channel: 'stable' },
        target: { source: 'upstream', channel: 'adhoc' }
      })
    ).toBe(true)
  })
})
