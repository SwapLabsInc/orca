import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  findInstallerAssetName,
  isAdhocVersion,
  isDailyVersion,
  isHourlyVersion,
  parseAdhocVersionStamp,
  parseDailyVersionStamp,
  parseHourlyVersionStamp,
  requiresManualDevChannelInstall,
  sortReleaseBuildsNewestFirst,
  type ReleaseBuild,
  type ReleaseChannel
} from './release-channel'
import { compareAppVersions } from './app-version'
import type * as ReleaseChannelModule from './release-channel.js'
import {
  FORK_RELEASE_SOURCES_LITERAL,
  setReleaseSourcesLiteralForTest
} from './release-sources.fixture'

describe('release channel', () => {
  // Reject garbage-prefix versions and Date.UTC’s normalization of impossible dates (February 30→March 2).
  it('rejects a bad base version and impossible calendar stamps', () => {
    expect(parseHourlyVersionStamp('not-a-version-hourly.202601010000')).toBeNull()
    expect(parseHourlyVersionStamp('1.4-hourly.202601010000')).toBeNull()
    expect(parseHourlyVersionStamp('1.4.160-hourly.202602300000')).toBeNull()
    expect(parseHourlyVersionStamp('1.4.160-hourly.202613010000')).toBeNull()
    expect(parseHourlyVersionStamp('1.4.160-hourly.202601012500')).toBeNull()
    // Leap day 2028 is real and must still parse.
    expect(parseHourlyVersionStamp('1.4.160-hourly.202802290000')?.toISOString()).toBe(
      '2028-02-29T00:00:00.000Z'
    )
    expect(parseDailyVersionStamp('1.4.160-daily.202602300000')).toBeNull()
    expect(parseDailyVersionStamp('not-a-version-daily.202601010000')).toBeNull()
  })

  it('keeps the dev stamp formats from matching each other', () => {
    expect(isAdhocVersion('1.4.160-hourly.202607281400')).toBe(false)
    expect(isHourlyVersion('1.4.160-adhoc.20260728140533')).toBe(false)
    expect(isDailyVersion('1.4.160-hourly.202607281400')).toBe(false)
    expect(isHourlyVersion('1.4.160-daily.202607281300')).toBe(false)
    expect(isDailyVersion('1.4.160-adhoc.20260728140533')).toBe(false)
    // Minute-only tails are not valid second-resolution adhoc stamps.
    expect(isAdhocVersion('1.4.160-adhoc.202607281405')).toBe(false)
  })

  it('rejects impossible adhoc calendar stamps, including the seconds field', () => {
    expect(parseAdhocVersionStamp('1.4.160-adhoc.20260230000000')).toBeNull()
    expect(parseAdhocVersionStamp('1.4.160-adhoc.20261301000000')).toBeNull()
    expect(parseAdhocVersionStamp('1.4.160-adhoc.20260101250000')).toBeNull()
    expect(parseAdhocVersionStamp('1.4.160-adhoc.20260101000060')).toBeNull()
    expect(parseAdhocVersionStamp('not-a-version-adhoc.20260101000000')).toBeNull()
  })

  // Installed signed Windows apps reject unsigned dev installers via baked-in publisherName; future builds cannot fix them.
  // Dev apps omit the name, allowing every outbound switch including stable.
  it('requires a manual install only when entering a dev channel from a signed Windows build', () => {
    const manual = (runningChannel: ReleaseChannel | null, targetChannel: ReleaseChannel) =>
      requiresManualDevChannelInstall({ platform: 'win32', runningChannel, targetChannel })

    expect(manual('stable', 'adhoc')).toBe(true)
    expect(manual('rc', 'hourly')).toBe(true)
    expect(manual('stable', 'daily')).toBe(true)
    // Unknown running versions conservatively assume signed and offer a working manual download.
    expect(manual(null, 'adhoc')).toBe(true)

    // Already unsigned — the updater skips verification entirely from here.
    expect(manual('adhoc', 'hourly')).toBe(false)
    expect(manual('hourly', 'adhoc')).toBe(false)
    expect(manual('hourly', 'stable')).toBe(false)
    expect(manual('adhoc', 'rc')).toBe(false)

    expect(manual('stable', 'rc')).toBe(false)
    expect(manual('rc', 'stable')).toBe(false)
  })

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

  // Timestamp tails distinguish consecutive hourlies; keep picker ordering chronological.
  it('sorts consecutive hourly builds newest first', () => {
    const build = (version: string): ReleaseBuild => ({
      tag: `v${version}`,
      version,
      channel: 'hourly',
      name: null,
      publishedAt: null,
      releaseUrl: `https://github.com/stablyai/orca-hourly/releases/tag/v${version}`,
      installerUrl: null
    })
    const sorted = sortReleaseBuildsNewestFirst([
      build('1.4.160-hourly.202607280900'),
      build('1.4.160-hourly.202607281400'),
      build('1.4.160-hourly.202607281000')
    ])
    expect(sorted.map((entry) => entry.version)).toEqual([
      '1.4.160-hourly.202607281400',
      '1.4.160-hourly.202607281000',
      '1.4.160-hourly.202607280900'
    ])
  })

  // Main-derived hourlies must rank below their stable base so routine checks cannot select them.
  it('orders an hourly below its own stable release', () => {
    expect(compareAppVersions('1.4.160-hourly.202607281400', '1.4.160')).toBeLessThan(0)
  })

  it('orders a daily below its own stable release and below hourly of the same base', () => {
    expect(compareAppVersions('1.4.160-daily.202607281300', '1.4.160')).toBeLessThan(0)
    expect(
      compareAppVersions('1.4.160-daily.202607281300', '1.4.160-hourly.202607281400')
    ).toBeLessThan(0)
  })

  // Unlanded adhoc builds rank below all same-base channels; routine updates must never select them.
  it('orders an adhoc build below every other channel of its base version', () => {
    const adhoc = '1.4.160-adhoc.20260728140533'
    expect(compareAppVersions(adhoc, '1.4.160')).toBeLessThan(0)
    expect(compareAppVersions(adhoc, '1.4.160-rc.1')).toBeLessThan(0)
    expect(compareAppVersions(adhoc, '1.4.160-hourly.202607280000')).toBeLessThan(0)
    expect(compareAppVersions(adhoc, '1.4.160-daily.202607281300')).toBeLessThan(0)
  })

  it('sorts consecutive adhoc builds newest first', () => {
    const build = (version: string): ReleaseBuild => ({
      tag: `v${version}`,
      version,
      channel: 'adhoc',
      name: null,
      publishedAt: null,
      releaseUrl: `https://github.com/stablyai/orca-adhoc/releases/tag/v${version}`,
      installerUrl: null
    })
    const sorted = sortReleaseBuildsNewestFirst([
      build('1.4.160-adhoc.20260728140502'),
      build('1.4.160-adhoc.20260728140541'),
      build('1.4.160-adhoc.20260728090000')
    ])
    expect(sorted.map((entry) => entry.version)).toEqual([
      '1.4.160-adhoc.20260728140541',
      '1.4.160-adhoc.20260728140502',
      '1.4.160-adhoc.20260728090000'
    ])
  })

  it('sorts dev builds by their cut time across different base versions', () => {
    const build = (version: string): ReleaseBuild => ({
      tag: `v${version}`,
      version,
      channel: 'adhoc',
      name: null,
      publishedAt: null,
      releaseUrl: `https://github.com/stablyai/orca-adhoc/releases/tag/v${version}`,
      installerUrl: null
    })
    const sorted = sortReleaseBuildsNewestFirst([
      build('1.4.207-adhoc.20260919025813'),
      build('1.4.206-adhoc.20260919173504')
    ])
    expect(sorted.map((entry) => entry.version)).toEqual([
      '1.4.206-adhoc.20260919173504',
      '1.4.207-adhoc.20260919025813'
    ])
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
