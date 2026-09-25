import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { setReleaseSourcesLiteralForTest } from '../../../shared/release-sources.fixture'
import {
  FIXTURE_FEED_URL,
  FIXTURE_RELEASE_PAGE_URL,
  createMacSelfUpdateEngineFixture,
  type MacSelfUpdateEngineFixture
} from './mac-self-update-engine.fixture'
import {
  MAC_SELF_UPDATE_HELPER_SCRIPT,
  MAC_SELF_UPDATE_HEALTH_TIMEOUT_SECONDS
} from './mac-self-update-helper'
import { readMacSelfUpdateInstallState } from './mac-self-update-install-state'

vi.mock('../../updater-lifecycle-diagnostics', () => ({ recordUpdaterLifecycle: vi.fn() }))

// Why hoisted: the source registry reads its define once, when the first import loads it.
vi.hoisted(async () => {
  const fixture = await import('../../../shared/release-sources.fixture')
  fixture.setReleaseSourcesLiteralForTest(fixture.FORK_RELEASE_SOURCES_LITERAL)
})

type Emitted = { event: string; payload: unknown }

function recordEvents(engine: MacSelfUpdateEngineFixture['engine']): Emitted[] {
  const emitted: Emitted[] = []
  for (const event of [
    'checking-for-update',
    'update-available',
    'update-not-available',
    'download-progress',
    'update-downloaded',
    'error'
  ] as const) {
    engine.on(event, (payload: unknown) => emitted.push({ event, payload }))
  }
  return emitted
}

describe('MacSelfUpdateEngine', () => {
  let fixture: MacSelfUpdateEngineFixture | null = null

  afterEach(() => {
    fixture?.cleanup()
    fixture = null
  })

  afterAll(() => {
    setReleaseSourcesLiteralForTest(null)
  })

  it('checks the pinned tag, verifies the signed manifest and offers the newer build', async () => {
    fixture = createMacSelfUpdateEngineFixture()
    const emitted = recordEvents(fixture.engine)
    fixture.engine.setFeedURL({ provider: 'generic', url: FIXTURE_FEED_URL })

    await expect(fixture.engine.checkForUpdates()).resolves.toBeNull()

    expect(fixture.fetchedUrls).toEqual([
      `${FIXTURE_FEED_URL}/swaplabs-update-mac-arm64.json`,
      `${FIXTURE_FEED_URL}/swaplabs-update-mac-arm64.json.sig`
    ])
    expect(emitted.map((entry) => entry.event)).toEqual(['checking-for-update', 'update-available'])
    expect(emitted[1].payload).toMatchObject({
      version: fixture.targetVersion,
      files: [{ url: 'orca-macos-arm64.zip' }]
    })
  })

  it('reports not-available for a build that is not newer, and takes a pinned downgrade', async () => {
    fixture = createMacSelfUpdateEngineFixture({
      currentVersion: '1.4.197-swaplabs.202609261200'
    })
    const emitted = recordEvents(fixture.engine)
    fixture.engine.setFeedURL({ provider: 'generic', url: FIXTURE_FEED_URL })
    await fixture.engine.checkForUpdates()
    expect(emitted.map((entry) => entry.event)).toEqual([
      'checking-for-update',
      'update-not-available'
    ])

    fixture.engine.allowDowngrade = true
    fixture.engine.setFeedURL({
      provider: 'generic',
      url: FIXTURE_FEED_URL,
      expectedVersion: fixture.targetVersion
    })
    await fixture.engine.checkForUpdates()
    expect(emitted.at(-1)).toMatchObject({ event: 'update-available' })
  })

  it('refuses a manifest signed by another key, pointing at the release page', async () => {
    fixture = createMacSelfUpdateEngineFixture({ signWithForeignKey: true })
    const emitted = recordEvents(fixture.engine)
    fixture.engine.setFeedURL({ provider: 'generic', url: FIXTURE_FEED_URL })

    await expect(fixture.engine.checkForUpdates()).rejects.toMatchObject({
      reason: 'signature-invalid',
      presentation: { retryable: false, manualInstallUrl: FIXTURE_RELEASE_PAGE_URL }
    })
    expect(emitted.at(-1)).toMatchObject({
      event: 'error',
      payload: expect.objectContaining({ reason: 'signature-invalid' })
    })
    // Nothing verified means nothing to download.
    await expect(fixture.engine.downloadUpdate()).rejects.toMatchObject({
      reason: 'nothing-staged'
    })
  })

  it('downloads, extracts, verifies and stages the bundle, then quits into the helper', async () => {
    fixture = createMacSelfUpdateEngineFixture()
    const emitted = recordEvents(fixture.engine)
    fixture.engine.setFeedURL({ provider: 'generic', url: FIXTURE_FEED_URL })
    await fixture.engine.checkForUpdates()

    const stagedAppPath = join(fixture.paths.stagingDir, 'Orca.app')
    await expect(fixture.engine.downloadUpdate()).resolves.toEqual([stagedAppPath])

    expect(fixture.fetchedUrls.at(-1)).toBe(`${FIXTURE_FEED_URL}/orca-macos-arm64.zip`)
    const events = emitted.map((entry) => entry.event)
    expect(events.slice(0, 2)).toEqual(['checking-for-update', 'update-available'])
    expect(events.filter((event) => event === 'download-progress').length).toBeGreaterThan(0)
    expect(events.at(-1)).toBe('update-downloaded')
    expect(emitted.at(-1)?.payload).toMatchObject({
      version: fixture.targetVersion,
      downloadedFile: stagedAppPath
    })
    // The zip is gone once unpacked; the verified bundle waits in staging beside the app.
    expect(existsSync(join(fixture.paths.downloadsDir, 'orca-macos-arm64.zip'))).toBe(false)
    expect(readFileSync(join(stagedAppPath, 'Contents', 'MacOS', 'Orca'), 'utf8')).toBe('new build')
    const tools = fixture.runCalls.map((call) => call.program.split('/').pop())
    expect(tools).toEqual([
      'ditto',
      'codesign',
      'PlistBuddy',
      'PlistBuddy',
      'codesign',
      'xattr',
      'xattr'
    ])
    // Nothing from the download is executed: the only programs run are Apple's own tools.
    expect(fixture.runCalls.every((call) => call.program.startsWith('/usr/'))).toBe(true)

    fixture.engine.quitAndInstall(false, true)

    expect(fixture.requestQuit).toHaveBeenCalledTimes(1)
    expect(fixture.spawnHelper).toHaveBeenCalledTimes(1)
    const [program, args] = fixture.spawnHelper.mock.calls[0]
    expect(program).toBe('/bin/sh')
    expect(args).toEqual([
      '-c',
      MAC_SELF_UPDATE_HELPER_SCRIPT,
      'orca-mac-self-update',
      '1234',
      fixture.paths.appPath,
      stagedAppPath,
      fixture.paths.rollbackAppPath,
      fixture.paths.healthMarkerPath,
      '/usr/bin/open',
      String(MAC_SELF_UPDATE_HEALTH_TIMEOUT_SECONDS),
      fixture.paths.helperOutcomePath,
      'Contents/MacOS/Orca'
    ])
    expect(readMacSelfUpdateInstallState(fixture.paths.installStatePath)).toMatchObject({
      phase: 'install-requested',
      fromVersion: '1.4.197-swaplabs.202609241530',
      targetVersion: fixture.targetVersion,
      stagedAppPath,
      relaunchOwner: 'helper'
    })
  })

  it('leaves the relaunch to a serve supervisor when autoRunAppAfterInstall is off', async () => {
    fixture = createMacSelfUpdateEngineFixture()
    fixture.engine.setFeedURL({ provider: 'generic', url: FIXTURE_FEED_URL })
    await fixture.engine.checkForUpdates()
    await fixture.engine.downloadUpdate()
    fixture.engine.autoRunAppAfterInstall = false

    fixture.engine.quitAndInstall(true, false)

    const [, args] = fixture.spawnHelper.mock.calls[0]
    expect(args[8]).toBe('')
    expect(readMacSelfUpdateInstallState(fixture.paths.installStatePath)).toMatchObject({
      relaunchOwner: 'supervisor'
    })
  })

  it.each([
    [
      'a bundle version other than the manifest promised',
      { stagedBundleVersion: '1.4.196' },
      'bundle-version-mismatch'
    ],
    [
      'a bundle signed with another identity',
      { stagedRequirement: 'cdhash H"00"' },
      'signing-identity-mismatch'
    ],
    ['a zip the server cannot serve', { zipStatus: 500 }, 'download-failed']
  ])('discards the staging directory on %s', async (_label, options, reason) => {
    fixture = createMacSelfUpdateEngineFixture(options)
    const emitted = recordEvents(fixture.engine)
    fixture.engine.setFeedURL({ provider: 'generic', url: FIXTURE_FEED_URL })
    await fixture.engine.checkForUpdates()

    await expect(fixture.engine.downloadUpdate()).rejects.toMatchObject({
      reason,
      presentation: expect.objectContaining({ manualInstallUrl: FIXTURE_RELEASE_PAGE_URL })
    })
    expect(emitted.at(-1)).toMatchObject({ event: 'error' })
    expect(existsSync(fixture.paths.stagingDir)).toBe(false)
    expect(existsSync(join(fixture.paths.downloadsDir, 'orca-macos-arm64.zip'))).toBe(false)
    expect(fixture.spawnHelper).not.toHaveBeenCalled()
    // A failed stage leaves nothing to install.
    const errors: unknown[] = []
    fixture.engine.on('error', (error) => errors.push(error))
    fixture.engine.quitAndInstall()
    expect(errors.at(-1)).toMatchObject({ reason: 'nothing-staged' })
    expect(fixture.requestQuit).not.toHaveBeenCalled()
  })

  it('refuses to download before a check pinned a feed', async () => {
    fixture = createMacSelfUpdateEngineFixture()
    await expect(fixture.engine.checkForUpdates()).rejects.toMatchObject({ reason: 'no-feed' })
  })
})
