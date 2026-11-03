import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setHostSliceForTest } from '../../updater-host-slice.fixture'
import {
  FORK_RELEASE_SOURCES_LITERAL,
  setReleaseSourcesLiteralForTest
} from '../../../shared/release-sources.fixture'

const { netFetchMock } = vi.hoisted(() => ({ netFetchMock: vi.fn() }))

vi.mock('electron', () => ({ net: { fetch: netFetchMock, request: vi.fn() } }))

const DAY_MS = 24 * 60 * 60 * 1000
const NOW = Date.parse('2026-11-02T12:00:00Z')
const CURRENT_VERSION = '1.4.197-swaplabs.202610010000'
const HELD = {
  tag: 'swaplabs-v1.4.197+202611011200',
  version: '1.4.197-swaplabs.202611011200',
  updated: new Date(NOW - DAY_MS).toISOString()
}
// Why untitled: its version comes from the manifest, so its date must survive that second pass.
const AGED = {
  tag: 'swaplabs-v1.4.197+202610200000',
  version: '1.4.197-swaplabs.202610200000',
  updated: new Date(NOW - 13 * DAY_MS).toISOString()
}

function respondWithDatedForkFeed(): void {
  const feed = [
    `<entry><updated>${HELD.updated}</updated><link href="https://github.com/SwapLabsInc/orca/releases/tag/${encodeURIComponent(HELD.tag)}"/><title>${HELD.version}</title></entry>`,
    `<entry><updated>${AGED.updated}</updated><link href="https://github.com/SwapLabsInc/orca/releases/tag/${encodeURIComponent(AGED.tag)}"/><title>SwapLabs build</title></entry>`
  ].join('')
  netFetchMock.mockImplementation((url: string, init?: { method?: string }) => {
    if (url.endsWith('/releases.atom')) {
      return Promise.resolve({
        ok: true,
        text: () => Promise.resolve(`<feed>${feed}</feed>`)
      })
    }
    if (init?.method === 'HEAD') {
      return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve('') })
    }
    const version = url.includes(encodeURIComponent(AGED.tag)) ? AGED.version : HELD.version
    return Promise.resolve({
      ok: true,
      status: 200,
      text: () =>
        Promise.resolve(
          [`version: ${version}`, 'files:', `  - url: Orca-${version}.AppImage`].join('\n')
        )
    })
  })
}

describe('the update delay on a source other than the primary', () => {
  let restoreHostSlice = (): void => {}

  beforeEach(() => {
    vi.resetModules()
    netFetchMock.mockReset()
    setReleaseSourcesLiteralForTest(FORK_RELEASE_SOURCES_LITERAL)
    restoreHostSlice = setHostSliceForTest({ platform: 'linux', arch: 'x64' })
  })

  afterEach(() => {
    setReleaseSourcesLiteralForTest(null)
    restoreHostSlice()
  })

  it('dates titled and manifest-named releases from their own feed entries', async () => {
    respondWithDatedForkFeed()
    const { fetchNewerReleaseTagsWithReadiness } = await import('./updater-prerelease-feed')
    const { getReleaseSource } = await import('../../../shared/release-sources')

    const result = await fetchNewerReleaseTagsWithReadiness(CURRENT_VERSION, 1, {
      source: getReleaseSource('swaplabs')!,
      minReleaseAgeMs: 7 * DAY_MS,
      now: NOW
    })

    expect(result.tags).toEqual([AGED.tag])
    expect(result.releaseDelay?.heldRelease).toEqual({
      tag: HELD.tag,
      version: HELD.version,
      releasedAt: NOW - DAY_MS
    })
    expect(result.releaseDelay?.isTagOldEnough(AGED.tag)).toBe(true)
  })
})
