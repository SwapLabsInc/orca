import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { compareAppVersions } from '../../src/shared/app-version'
import {
  SWAPLABS_PRERELEASE_IDENTIFIER,
  createSwaplabsBuildVersion,
  createSwaplabsReleaseTag,
  formatSwaplabsBuildStamp,
  formatSwaplabsReleaseName,
  getSwaplabsBuildIdentity,
  parseSwaplabsBaseVersion,
  requireSwaplabsDelta
} from './swaplabs-build-version.mjs'

const at = new Date('2026-09-24T15:30:00Z')

describe('createSwaplabsBuildVersion', () => {
  it('stamps the base with the fork identifier and a zero-padded UTC minute', () => {
    expect(createSwaplabsBuildVersion('1.4.197', new Date('2026-07-28T04:05:59Z'))).toBe(
      '1.4.197-swaplabs.202607280405'
    )
  })

  // Plan decision D2: the base keeps the upstream rc tail, so the fork identifiers
  // continue the existing prerelease with a dot rather than opening a second one.
  it('keeps an rc tail and continues its prerelease', () => {
    expect(createSwaplabsBuildVersion('1.4.198-rc.1', at)).toBe(
      '1.4.198-rc.1.swaplabs.202609241530'
    )
  })

  // Plan decision D1: the stamp precedes the delta so time wins over the label.
  it('appends a delta after the stamp', () => {
    expect(createSwaplabsBuildVersion('1.4.197', at, 'resume.1')).toBe(
      '1.4.197-swaplabs.202609241530.resume.1'
    )
    expect(createSwaplabsBuildVersion('1.4.198-rc.1', at, 'resume.1')).toBe(
      '1.4.198-rc.1.swaplabs.202609241530.resume.1'
    )
  })

  it('orders fork builds by stamp, whatever their deltas say', () => {
    const older = createSwaplabsBuildVersion('1.4.197', at, 'resume.2')
    const newer = createSwaplabsBuildVersion(
      '1.4.197',
      new Date('2026-09-24T15:31:00Z'),
      'resume.1'
    )
    expect(compareAppVersions(older, newer)).toBeLessThan(0)
    expect(
      compareAppVersions(
        createSwaplabsBuildVersion('1.4.197', at),
        createSwaplabsBuildVersion('1.4.197', at, 'resume.1')
      )
    ).toBeLessThan(0)
  })

  // Documented consequence of keeping the rc tail: a fork build of an RC ranks
  // above that RC and below the stable, while a stable-based fork build ranks
  // below its stable. Cross-source comparisons are never made by semver; this
  // pins the ordering the updater's source registry is built to ignore.
  it('sits between its rc base and the stable, and below a stable base', () => {
    const rcBuild = createSwaplabsBuildVersion('1.4.198-rc.1', at)
    expect(compareAppVersions(rcBuild, '1.4.198-rc.1')).toBeGreaterThan(0)
    expect(compareAppVersions(rcBuild, '1.4.198')).toBeLessThan(0)
    expect(compareAppVersions(createSwaplabsBuildVersion('1.4.197', at), '1.4.197')).toBeLessThan(0)
  })

  it('rejects invalid input', () => {
    expect(() => createSwaplabsBuildVersion('nope', at)).toThrow(/valid semver/)
    expect(() => createSwaplabsBuildVersion('1.4.197', new Date('nope'))).toThrow(/invalid/)
    expect(() => createSwaplabsBuildVersion('1.4.197', at, 'resume..1')).toThrow(/empty/)
    expect(() => createSwaplabsBuildVersion('1.4.197', at, 'resume.01')).toThrow(/leading zero/)
    expect(() => createSwaplabsBuildVersion('1.4.197', at, 'resume 1')).toThrow(/alphanumerics/)
  })

  it('refuses a base that already carries the fork identifier', () => {
    expect(() => createSwaplabsBuildVersion('1.4.197-swaplabs.202609241530', at)).toThrow(
      /already carries/
    )
  })
})

describe('createSwaplabsReleaseTag', () => {
  // The tag is the orca-fork-ops form (`swaplabs-v<base>+<delta>`); the stamp
  // takes the delta's place when a push, not an operator, named the build.
  it('uses the stamp when no delta names the build', () => {
    expect(createSwaplabsReleaseTag('1.4.197', { stamp: '202609241530' })).toBe(
      'swaplabs-v1.4.197+202609241530'
    )
    expect(createSwaplabsReleaseTag('1.4.198-rc.1', { stamp: '202609241530' })).toBe(
      'swaplabs-v1.4.198-rc.1+202609241530'
    )
  })

  it('uses the delta when one is given, matching orca-fork-ops release_tag()', () => {
    expect(createSwaplabsReleaseTag('1.4.204', { stamp: '202609241530', delta: 'resume.1' })).toBe(
      'swaplabs-v1.4.204+resume.1'
    )
  })

  it('rejects a malformed stamp or delta', () => {
    expect(() => createSwaplabsReleaseTag('1.4.197', { stamp: '2026092415' })).toThrow(
      /YYYYMMDDHHMM/
    )
    expect(() =>
      createSwaplabsReleaseTag('1.4.197', { stamp: '202609241530', delta: '.' })
    ).toThrow(/empty/)
  })
})

describe('formatSwaplabsBuildStamp', () => {
  it('pads every field and reads the clock in UTC', () => {
    expect(formatSwaplabsBuildStamp(new Date('2026-01-05T03:07:00Z'))).toBe('202601050307')
  })
})

describe('formatSwaplabsReleaseName', () => {
  it('leads with the full app version, then the Pacific time and short sha', () => {
    expect(formatSwaplabsReleaseName('1.4.197-swaplabs.202609241530', 'abc1234def56', at)).toBe(
      '1.4.197-swaplabs.202609241530 • Sep 24, 8:30AM • abc1234'
    )
  })

  it('rejects a commit that is not a hex sha', () => {
    expect(() => formatSwaplabsReleaseName('1.4.197-swaplabs.202609241530', 'HEAD', at)).toThrow(
      /hex SHA/
    )
  })
})

describe('parseSwaplabsBaseVersion and requireSwaplabsDelta', () => {
  it('splits core and prerelease and validates the tail identifiers', () => {
    expect(parseSwaplabsBaseVersion('1.4.197')).toEqual({ core: '1.4.197', prerelease: null })
    expect(parseSwaplabsBaseVersion('1.4.198-rc.1')).toEqual({
      core: '1.4.198',
      prerelease: 'rc.1'
    })
    expect(() => parseSwaplabsBaseVersion('1.4.198-rc.01')).toThrow(/leading zero/)
  })

  it('mirrors the orca-fork-ops delta rules', () => {
    expect(() => requireSwaplabsDelta('')).toThrow(/empty/)
    expect(() => requireSwaplabsDelta('resume.')).toThrow(/empty dot-separated/)
    expect(() => requireSwaplabsDelta('résumé.1')).toThrow(/alphanumerics/)
    expect(() => requireSwaplabsDelta('resume.1')).not.toThrow()
    expect(() => requireSwaplabsDelta('fix-123')).not.toThrow()
  })
})

describe('getSwaplabsBuildIdentity', () => {
  const withPackageVersion = (version, run) => {
    const directory = mkdtempSync(join(tmpdir(), 'swaplabs-identity-'))
    const packageJsonPath = join(directory, 'package.json')
    writeFileSync(packageJsonPath, JSON.stringify({ version }))
    try {
      return run(packageJsonPath)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  }

  // The tag, version and title are three spellings of one identity; a workflow
  // that consumed them separately must never see them disagree.
  it('emits one consistent identity from package.json and HEAD', () => {
    withPackageVersion('1.4.198-rc.1', (packageJsonPath) => {
      const identity = getSwaplabsBuildIdentity(at, { packageJsonPath })
      expect(identity.base).toBe('1.4.198-rc.1')
      expect(identity.stamp).toBe('202609241530')
      expect(identity.version).toBe('1.4.198-rc.1.swaplabs.202609241530')
      expect(identity.tag).toBe('swaplabs-v1.4.198-rc.1+202609241530')
      expect(identity.commit).toMatch(/^[0-9a-f]{12}$/)
      expect(identity.name).toBe(
        `${identity.version} • Sep 24, 8:30AM • ${identity.commit.slice(0, 7)}`
      )
      expect(identity.version.split(/[-.]/)).toContain(SWAPLABS_PRERELEASE_IDENTIFIER)
    })
  })

  it('carries a delta into both the version and the tag', () => {
    withPackageVersion('1.4.204', (packageJsonPath) => {
      const identity = getSwaplabsBuildIdentity(at, { packageJsonPath, delta: 'resume.1' })
      expect(identity.version).toBe('1.4.204-swaplabs.202609241530.resume.1')
      expect(identity.tag).toBe('swaplabs-v1.4.204+resume.1')
    })
  })
})
