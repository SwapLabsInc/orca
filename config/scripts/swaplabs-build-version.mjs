import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { formatReleaseTitleTimestamp } from './release-title-timestamp.mjs'

// LOCAL: SwapLabs fork build identity. Emits the two forms of one identity that
// `orca-fork-ops build-version` also produces — the app version the packaged app
// reports and the git tag the release is published under — plus a minute stamp
// so fork builds order by time. Its unit test pins both strings so the CI script
// and the skill cannot drift apart silently.

/** Prerelease identifier every SwapLabs build carries; the updater's source registry keys on it. */
export const SWAPLABS_PRERELEASE_IDENTIFIER = 'swaplabs'
/** `swaplabs-v1.4.197+202609241530` — the orca-fork-ops tag form; `+` stays on the tag only. */
export const SWAPLABS_TAG_PREFIX = 'swaplabs-v'

const SEMVER = /^(\d+\.\d+\.\d+)(?:-([0-9A-Za-z.-]+))?$/
const PRERELEASE_IDENTIFIER = /^[0-9A-Za-z-]+$/
const BUILD_STAMP = /^\d{12}$/

/**
 * Every dot-separated part must be a legal semver prerelease identifier: non-empty,
 * `[0-9A-Za-z-]`, and free of a leading zero when numeric. A charset regex cannot
 * express the last rule, and the packaging step rejects the version long after a
 * looser check would have said yes.
 */
function requirePrereleaseIdentifiers(value, what) {
  for (const identifier of value.split('.')) {
    if (!identifier) {
      throw new Error(
        `${what} has an empty dot-separated part (e.g. resume.1): ${JSON.stringify(value)}`
      )
    }
    if (!PRERELEASE_IDENTIFIER.test(identifier)) {
      throw new Error(
        `${what} parts must be alphanumerics and dashes, separated by dots (e.g. resume.1): ${JSON.stringify(value)}`
      )
    }
    if (/^0\d/.test(identifier)) {
      throw new Error(
        `${what} part ${JSON.stringify(identifier)} is numeric with a leading zero, which semver forbids in a prerelease: ${JSON.stringify(value)}`
      )
    }
  }
}

/** Reject a delta that would make the app version invalid semver. Mirrors orca-fork-ops. */
export function requireSwaplabsDelta(delta) {
  if (typeof delta !== 'string' || !delta) {
    throw new Error('delta is empty; pass something like resume.1')
  }
  requirePrereleaseIdentifiers(delta, 'delta')
}

/**
 * The upstream base the build sits on, as `package.json` carries it. Any `-rc.N`
 * tail is kept (plan decision D2), so it has to satisfy the same identifier rules
 * as the delta appended after it.
 */
export function parseSwaplabsBaseVersion(baseVersion) {
  const match = SEMVER.exec(String(baseVersion ?? ''))
  if (!match) {
    throw new Error(`Package version is not valid semver: ${baseVersion}`)
  }
  const [, core, prerelease] = match
  if (prerelease !== undefined) {
    requirePrereleaseIdentifiers(prerelease, 'package version prerelease')
    // Why: a package.json that already carries the fork identifier would stamp it
    // twice, and the updater classifies the build by the first occurrence.
    if (prerelease.split('.').includes(SWAPLABS_PRERELEASE_IDENTIFIER)) {
      throw new Error(
        `Package version already carries the ${SWAPLABS_PRERELEASE_IDENTIFIER} identifier: ${baseVersion}`
      )
    }
  }
  return { core, prerelease: prerelease ?? null }
}

/** `202609241530` — UTC to the minute, the same stamp hourly builds use as their sort key. */
export function formatSwaplabsBuildStamp(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    throw new Error('SwapLabs build timestamp is invalid.')
  }
  const pad = (value, width = 2) => String(value).padStart(width, '0')
  return [
    pad(date.getUTCFullYear(), 4),
    pad(date.getUTCMonth() + 1),
    pad(date.getUTCDate()),
    pad(date.getUTCHours()),
    pad(date.getUTCMinutes())
  ].join('')
}

/**
 * `1.4.197-swaplabs.202609241530[.resume.1]`, or `1.4.198-rc.1.swaplabs.202609241530[.resume.1]`
 * when the base is an RC.
 *
 * Why the stamp comes before the delta: prerelease identifiers compare left to
 * right, so a delta first would order `resume.2` above a newer `resume.1`. Why a
 * prerelease suffix and not `+` build metadata: metadata is ignored in precedence
 * and several packaging targets reject `+` in a package version.
 */
export function createSwaplabsBuildVersion(baseVersion, date, delta = '') {
  const base = parseSwaplabsBaseVersion(baseVersion)
  const stamp = formatSwaplabsBuildStamp(date)
  if (delta) {
    requireSwaplabsDelta(delta)
  }
  const identifiers = [SWAPLABS_PRERELEASE_IDENTIFIER, stamp, delta].filter(Boolean).join('.')
  return base.prerelease ? `${baseVersion}.${identifiers}` : `${baseVersion}-${identifiers}`
}

/**
 * `swaplabs-v1.4.197+202609241530`, or `swaplabs-v1.4.197+resume.1` when a delta
 * names the build — the tag form `orca-fork-ops release_tag()` emits, kept by plan
 * decision D1. The updater never derives a version from this tag; it reads the
 * version from the release manifest and title.
 */
export function createSwaplabsReleaseTag(baseVersion, { stamp, delta = '' }) {
  parseSwaplabsBaseVersion(baseVersion)
  if (delta) {
    requireSwaplabsDelta(delta)
  } else if (!BUILD_STAMP.test(String(stamp ?? ''))) {
    throw new Error(`SwapLabs build stamp must be YYYYMMDDHHMM: ${stamp}`)
  }
  return `${SWAPLABS_TAG_PREFIX}${baseVersion}+${delta || stamp}`
}

/**
 * `1.4.197-swaplabs.202609241530 • Sep 24, 8:30AM • abc1234` — the release title.
 * The full app version leads because the updater and the build picker resolve a
 * fork release by the version in its title and manifest, never by its tag.
 */
export function formatSwaplabsReleaseName(version, commit, date) {
  if (!/^[0-9a-f]{7,40}$/.test(String(commit ?? ''))) {
    throw new Error(`Commit must be a hex SHA of at least 7 characters: ${commit}`)
  }
  return [version, formatReleaseTitleTimestamp(date), commit.slice(0, 7)].join(' • ')
}

export function getSwaplabsBuildIdentity(
  now = new Date(),
  { delta = '', packageJsonPath = resolve('package.json') } = {}
) {
  const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'))
  const commit = execFileSync('git', ['rev-parse', '--short=12', 'HEAD'], {
    encoding: 'utf8'
  }).trim()
  const base = packageJson.version
  const stamp = formatSwaplabsBuildStamp(now)
  const version = createSwaplabsBuildVersion(base, now, delta)
  return {
    base,
    stamp,
    delta,
    commit,
    version,
    tag: createSwaplabsReleaseTag(base, { stamp, delta }),
    name: formatSwaplabsReleaseName(version, commit, now)
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const identity = getSwaplabsBuildIdentity(new Date(), {
    delta: (process.env.ORCA_SWAPLABS_DELTA ?? '').trim()
  })
  // Consumed by the workflow via $GITHUB_OUTPUT; `name` last because it is the
  // one value that contains spaces.
  process.stdout.write(
    `version=${identity.version}\ntag=${identity.tag}\ncommit=${identity.commit}\nbase=${identity.base}\nstamp=${identity.stamp}\nname=${identity.name}\n`
  )
}
