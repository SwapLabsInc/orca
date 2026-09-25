import { describe, expect, it } from 'vitest'
import { collectSwaplabsPackagingProblems } from './verify-swaplabs-packaging.mjs'

const VERSION = '1.4.197-swaplabs.202609241530'
const SOURCES = JSON.stringify([
  { id: 'upstream', label: 'Orca upstream', repo: 'stablyai/orca', prereleaseIdentifier: null },
  { id: 'swaplabs', label: 'SwapLabs', repo: 'SwapLabsInc/orca', prereleaseIdentifier: 'swaplabs' }
])

const goodEnv = () => ({
  ORCA_RELEASE_SOURCES: SOURCES,
  ORCA_PUBLISH_OWNER: 'SwapLabsInc',
  ORCA_PUBLISH_REPO: 'orca',
  ORCA_LOCAL_BUILD_VERSION: VERSION
})

const goodConfig = () => ({
  publish: { provider: 'github', owner: 'SwapLabsInc', repo: 'orca', releaseType: 'prerelease' },
  extraMetadata: { version: VERSION },
  forceCodeSigning: false
})

const problems = (overrides = {}) =>
  collectSwaplabsPackagingProblems({
    config: overrides.config ?? goodConfig(),
    env: { ...goodEnv(), ...overrides.env },
    platform: overrides.platform ?? 'linux'
  })

describe('collectSwaplabsPackagingProblems', () => {
  it('accepts the identity the fork workflow sets', () => {
    expect(problems()).toEqual([])
    expect(problems({ platform: 'darwin' })).toEqual([])
  })

  // The failure that motivates the script: a checkout whose config predates the
  // release-sources change ignores every env var and keeps upstream's identity.
  it('names a config that still publishes to upstream', () => {
    const config = {
      ...goodConfig(),
      publish: { provider: 'github', owner: 'stablyai', repo: 'orca' }
    }
    expect(problems({ config })).toEqual([expect.stringContaining('stablyai/orca')])
  })

  it.each([
    ['unset', undefined, /unset/],
    ['not JSON', '{', /not JSON/],
    ['not an array', '{"id":"swaplabs"}', /array/],
    ['missing the fork source', JSON.stringify([JSON.parse(SOURCES)[0]]), /fork source/],
    ['missing the primary', JSON.stringify([JSON.parse(SOURCES)[1]]), /primary source/],
    [
      'duplicated ids',
      JSON.stringify([...JSON.parse(SOURCES), JSON.parse(SOURCES)[1]]),
      /duplicate ids/
    ]
  ])('rejects release sources that are %s', (_name, value, message) => {
    expect(problems({ env: { ORCA_RELEASE_SOURCES: value } })).toEqual([
      expect.stringMatching(message)
    ])
  })

  it('requires the stamped version to reach extraMetadata', () => {
    expect(problems({ env: { ORCA_LOCAL_BUILD_VERSION: undefined } })).toEqual([
      expect.stringContaining('ORCA_LOCAL_BUILD_VERSION is unset')
    ])
    expect(problems({ env: { ORCA_LOCAL_BUILD_VERSION: '1.4.197' } })).toEqual([
      expect.stringContaining('not a SwapLabs build version'),
      expect.stringContaining('extraMetadata.version')
    ])
    const config = { ...goodConfig(), extraMetadata: { version: '1.4.197' } }
    expect(problems({ config })).toEqual([expect.stringContaining('ORCA_MAC_* or ORCA_WIN_*')])
  })

  it('keeps fork builds silent in telemetry and ad-hoc on macOS', () => {
    expect(problems({ env: { ORCA_BUILD_IDENTITY: 'stable' } })).toEqual([
      expect.stringContaining('ORCA_BUILD_IDENTITY')
    ])
    expect(problems({ platform: 'darwin', env: { ORCA_MAC_RELEASE: '1' } })).toEqual([
      expect.stringContaining('ad-hoc')
    ])
    expect(problems({ platform: 'darwin', env: { CSC_LINK: 'base64' } })).toEqual([
      expect.stringContaining('CSC_LINK')
    ])
  })

  it('ties the publish env to the fork repository', () => {
    expect(problems({ env: { ORCA_PUBLISH_OWNER: 'stablyai' } })).toEqual([
      expect.stringContaining('ORCA_PUBLISH_OWNER/ORCA_PUBLISH_REPO')
    ])
  })
})
