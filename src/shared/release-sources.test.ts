import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ADHOC_PRERELEASE_IDENTIFIER,
  DAILY_PRERELEASE_IDENTIFIER,
  HOURLY_PRERELEASE_IDENTIFIER
} from './release-channel'
import type * as RegistryModule from './release-sources.js'
import { setReleaseSourcesLiteralForTest } from './release-sources.fixture'
import {
  DEFAULT_RELEASE_SOURCES,
  RESERVED_PRERELEASE_IDENTIFIERS,
  ReleaseSourcesConfigError,
  parseReleaseSources
} from './release-sources'

const UPSTREAM = {
  id: 'upstream',
  label: 'Orca upstream',
  repo: 'stablyai/orca',
  prereleaseIdentifier: null
}
const SWAPLABS = {
  id: 'swaplabs',
  label: 'SwapLabs',
  repo: 'SwapLabsInc/orca',
  prereleaseIdentifier: 'swaplabs'
}

/** Re-evaluates the registry against a define literal, the way a packaged build reads it. */
async function loadRegistry(literal: string | null): Promise<typeof RegistryModule> {
  vi.resetModules()
  setReleaseSourcesLiteralForTest(literal)
  return import('./release-sources.js')
}

afterEach(() => {
  setReleaseSourcesLiteralForTest(null)
  vi.restoreAllMocks()
})

describe('parseReleaseSources', () => {
  it('parses a primary plus stamped sources', () => {
    expect(parseReleaseSources(JSON.stringify([UPSTREAM, SWAPLABS]))).toEqual([UPSTREAM, SWAPLABS])
  })

  it('treats an absent prereleaseIdentifier on the primary as null', () => {
    const { prereleaseIdentifier: _omitted, ...primary } = UPSTREAM
    expect(parseReleaseSources(JSON.stringify([primary]))).toEqual([UPSTREAM])
  })

  it.each([
    ['not JSON', 'nope', /JSON array/],
    ['an object', '{}', /non-empty JSON array/],
    ['an empty array', '[]', /non-empty JSON array/],
    ['a non-object entry', '["x"]', /#0 must be an object/],
    ['a missing repo', JSON.stringify([{ id: 'upstream', label: 'Orca' }]), /"repo"/],
    ['a repo without an owner', JSON.stringify([{ ...UPSTREAM, repo: 'orca' }]), /owner\/name/],
    ['an id with uppercase', JSON.stringify([{ ...UPSTREAM, id: 'Upstream' }]), /id "Upstream"/],
    ['a stamped primary', JSON.stringify([SWAPLABS]), /first source is the primary/],
    [
      'an unstamped secondary',
      JSON.stringify([UPSTREAM, { ...SWAPLABS, prereleaseIdentifier: null }]),
      /needs a prereleaseIdentifier/
    ],
    [
      'a numeric identifier',
      JSON.stringify([UPSTREAM, { ...SWAPLABS, prereleaseIdentifier: '42' }]),
      /must not be numeric/
    ],
    [
      'an identifier with a dot',
      JSON.stringify([UPSTREAM, { ...SWAPLABS, prereleaseIdentifier: 'a.b' }]),
      /semver prerelease identifier/
    ],
    [
      'duplicate ids',
      JSON.stringify([UPSTREAM, { ...SWAPLABS, id: 'upstream' }]),
      /duplicate source id/
    ],
    [
      'duplicate repos',
      JSON.stringify([UPSTREAM, { ...SWAPLABS, repo: 'stablyai/orca' }]),
      /duplicate repo/
    ],
    [
      'duplicate identifiers',
      JSON.stringify([
        UPSTREAM,
        SWAPLABS,
        { ...SWAPLABS, id: 'other', repo: 'o/r', prereleaseIdentifier: 'SwapLabs' }
      ]),
      /duplicate prereleaseIdentifier/
    ]
  ])('rejects %s', (_label, literal, message) => {
    expect(() => parseReleaseSources(literal)).toThrow(ReleaseSourcesConfigError)
    expect(() => parseReleaseSources(literal)).toThrow(message)
  })

  // Why: a source stamped `hourly` would be filed under the hourly channel and pinned to the hourly repo.
  it.each(RESERVED_PRERELEASE_IDENTIFIERS)('rejects the reserved identifier %s', (identifier) => {
    expect(() =>
      parseReleaseSources(
        JSON.stringify([UPSTREAM, { ...SWAPLABS, prereleaseIdentifier: identifier }])
      )
    ).toThrow(/reserved/)
  })

  it('reserves every dev-channel identifier the channel table defines', () => {
    for (const identifier of [
      HOURLY_PRERELEASE_IDENTIFIER,
      DAILY_PRERELEASE_IDENTIFIER,
      ADHOC_PRERELEASE_IDENTIFIER
    ]) {
      expect(RESERVED_PRERELEASE_IDENTIFIERS).toContain(identifier)
    }
  })
})

describe('release source registry', () => {
  it("defaults to the single upstream source with today's repo", async () => {
    const registry = await loadRegistry(null)

    expect(registry.RELEASE_SOURCES).toEqual(DEFAULT_RELEASE_SOURCES)
    expect(registry.PRIMARY_RELEASE_SOURCE.repo).toBe('stablyai/orca')
    expect(registry.isMultiSourceBuild()).toBe(false)
    expect(registry.getReleaseSource('swaplabs')).toBeNull()
  })

  it('reads the define literal', async () => {
    const registry = await loadRegistry(JSON.stringify([UPSTREAM, SWAPLABS]))

    expect(registry.isMultiSourceBuild()).toBe(true)
    expect(registry.getReleaseSource('swaplabs')).toEqual(SWAPLABS)
    expect(registry.getReleaseSourceOrPrimary('missing')).toEqual(UPSTREAM)
  })

  it('falls back to the default registry, loudly, when the define is invalid', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const registry = await loadRegistry('[')

    expect(registry.RELEASE_SOURCES).toEqual(DEFAULT_RELEASE_SOURCES)
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining('ORCA_RELEASE_SOURCES'),
      // Why not expect.any(): the re-evaluated module owns a different class object.
      expect.objectContaining({ name: 'ReleaseSourcesConfigError' })
    )
  })

  it('classifies versions by the identifier that follows the base', async () => {
    const { getVersionReleaseSource } = await loadRegistry(JSON.stringify([UPSTREAM, SWAPLABS]))

    expect(getVersionReleaseSource('1.4.197')).toBe('upstream')
    expect(getVersionReleaseSource('v1.4.197-rc.3')).toBe('upstream')
    expect(getVersionReleaseSource('1.4.197-rc.3.perf')).toBe('upstream')
    expect(getVersionReleaseSource('1.4.197-hourly.202607281400')).toBe('upstream')
    expect(getVersionReleaseSource('1.4.197-daily.202607281300')).toBe('upstream')
    expect(getVersionReleaseSource('1.4.197-adhoc.20260728140533')).toBe('upstream')
    expect(getVersionReleaseSource('1.4.197-swaplabs.202609241530')).toBe('swaplabs')
    expect(getVersionReleaseSource('1.4.197-swaplabs.202609241530.resume.1')).toBe('swaplabs')
    // An rc base keeps upstream's tail, so the source identifier sits after it.
    expect(getVersionReleaseSource('1.4.198-rc.1.swaplabs.202609241530')).toBe('swaplabs')
    // A fork build cut before stamps landed still belongs to its source.
    expect(getVersionReleaseSource('1.4.204-swaplabs.resume.1')).toBe('swaplabs')
    expect(getVersionReleaseSource('1.4.197-swaplabsx.202609241530')).toBe('upstream')
    expect(getVersionReleaseSource('garbage')).toBeNull()
  })

  it('files every version under the primary when only one source is configured', async () => {
    const { getVersionReleaseSource } = await loadRegistry(null)

    expect(getVersionReleaseSource('1.4.197-swaplabs.202609241530')).toBe('upstream')
  })

  it('builds a stamp pattern only for stamped sources', async () => {
    const { getReleaseSourceVersionPattern, getReleaseSource, PRIMARY_RELEASE_SOURCE } =
      await loadRegistry(JSON.stringify([UPSTREAM, SWAPLABS]))
    const pattern = getReleaseSourceVersionPattern(getReleaseSource('swaplabs')!)

    expect(getReleaseSourceVersionPattern(PRIMARY_RELEASE_SOURCE)).toBeNull()
    expect(pattern?.test('1.4.197-swaplabs.202609241530')).toBe(true)
    expect(pattern?.test('1.4.197-swaplabs.202609241530.resume.1')).toBe(true)
    expect(pattern?.test('1.4.198-rc.1.swaplabs.202609241530')).toBe(true)
    expect(pattern?.test('1.4.197-swaplabs.2026092415')).toBe(false)
    expect(pattern?.test('1.4.204-swaplabs.resume.1')).toBe(false)
  })
})
