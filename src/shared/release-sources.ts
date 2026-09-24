import { isValidAppVersion } from './app-version'
import { escapeRegex } from './string-utils'

export type ReleaseSourceId = string

/**
 * One GitHub repository whose releases the updater can install from. A build
 * belongs to exactly one source, derived from its version string, and routine
 * checks never leave it — only an explicit cross-source install does.
 */
export type ReleaseSource = {
  id: ReleaseSourceId
  /** Human-readable name, e.g. "Orca upstream" or "SwapLabs". */
  label: string
  /** GitHub `owner/name` that publishes this source's releases. */
  repo: string
  /**
   * null for the primary source, whose versions are the plain stable/rc series.
   * Every other source stamps its versions with this identifier right after the
   * base (`1.4.197-swaplabs.202609241530` or `1.4.198-rc.1.swaplabs.202609241530`).
   */
  prereleaseIdentifier: string | null
}

export const DEFAULT_RELEASE_SOURCES: readonly ReleaseSource[] = [
  { id: 'upstream', label: 'Orca upstream', repo: 'stablyai/orca', prereleaseIdentifier: null }
]

/** Identifiers the primary series and the dev channels already own; a source
 *  stamped with one would be filed under that channel instead of its source. */
export const RESERVED_PRERELEASE_IDENTIFIERS: readonly string[] = [
  'hourly',
  'daily',
  'adhoc',
  'rc',
  'perf',
  'local'
]

const SOURCE_ID_PATTERN = /^[a-z][a-z0-9-]*$/
const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/
const PRERELEASE_IDENTIFIER_PATTERN = /^[0-9A-Za-z-]+$/

export class ReleaseSourcesConfigError extends Error {
  constructor(message: string) {
    super(`ORCA_RELEASE_SOURCES: ${message}`)
    this.name = 'ReleaseSourcesConfigError'
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readString(entry: Record<string, unknown>, key: string, index: number): string {
  const value = entry[key]
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ReleaseSourcesConfigError(`source #${index} needs a non-empty string "${key}"`)
  }
  return value.trim()
}

function parseReleaseSource(raw: unknown, index: number): ReleaseSource {
  if (!isRecord(raw)) {
    throw new ReleaseSourcesConfigError(`source #${index} must be an object`)
  }
  const entry = raw
  const id = readString(entry, 'id', index)
  if (!SOURCE_ID_PATTERN.test(id)) {
    throw new ReleaseSourcesConfigError(
      `source #${index} id "${id}" must match ${SOURCE_ID_PATTERN}`
    )
  }
  const label = readString(entry, 'label', index)
  const repo = readString(entry, 'repo', index)
  if (!REPO_PATTERN.test(repo)) {
    throw new ReleaseSourcesConfigError(`source "${id}" repo "${repo}" must be "owner/name"`)
  }
  const identifier = entry.prereleaseIdentifier
  if (identifier === null || identifier === undefined) {
    return { id, label, repo, prereleaseIdentifier: null }
  }
  if (typeof identifier !== 'string' || !PRERELEASE_IDENTIFIER_PATTERN.test(identifier)) {
    throw new ReleaseSourcesConfigError(
      `source "${id}" prereleaseIdentifier must be a semver prerelease identifier`
    )
  }
  // Why: a numeric identifier compares as a number, so it could never be told apart from a build counter.
  if (/^\d+$/.test(identifier)) {
    throw new ReleaseSourcesConfigError(`source "${id}" prereleaseIdentifier must not be numeric`)
  }
  if (RESERVED_PRERELEASE_IDENTIFIERS.includes(identifier.toLowerCase())) {
    throw new ReleaseSourcesConfigError(
      `source "${id}" prereleaseIdentifier "${identifier}" is reserved for an existing channel`
    )
  }
  return { id, label, repo, prereleaseIdentifier: identifier }
}

function assertUnique(values: string[], what: string): void {
  const seen = new Set<string>()
  for (const value of values) {
    const key = value.toLowerCase()
    if (seen.has(key)) {
      throw new ReleaseSourcesConfigError(`duplicate ${what} "${value}"`)
    }
    seen.add(key)
  }
}

/**
 * Parses the `ORCA_RELEASE_SOURCES` JSON literal. The first entry is the primary
 * source and must have no prerelease identifier; every later one must have one.
 * Throws `ReleaseSourcesConfigError` so a build fails before packaging rather
 * than shipping an app that re-points itself at the wrong repository.
 */
export function parseReleaseSources(literal: string): readonly ReleaseSource[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(literal)
  } catch {
    throw new ReleaseSourcesConfigError('must be a JSON array')
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new ReleaseSourcesConfigError('must be a non-empty JSON array')
  }
  const sources = parsed.map((raw, index) => parseReleaseSource(raw, index))
  if (sources[0].prereleaseIdentifier !== null) {
    throw new ReleaseSourcesConfigError(
      'the first source is the primary and takes no prereleaseIdentifier'
    )
  }
  const unstamped = sources.slice(1).find((source) => source.prereleaseIdentifier === null)
  if (unstamped) {
    throw new ReleaseSourcesConfigError(`source "${unstamped.id}" needs a prereleaseIdentifier`)
  }
  assertUnique(
    sources.map((source) => source.id),
    'source id'
  )
  assertUnique(
    sources.map((source) => source.repo),
    'repo'
  )
  assertUnique(
    sources.flatMap((source) => (source.prereleaseIdentifier ? [source.prereleaseIdentifier] : [])),
    'prereleaseIdentifier'
  )
  return sources
}

declare global {
  /** Compile-time define from `electron.vite.config.ts`; absent in dev and tests. */
  const ORCA_RELEASE_SOURCES: string | null
}

function readReleaseSourcesLiteral(): string | null {
  // Why the descriptor read: tests stand the define in on globalThis, which the ambient `const` cannot name.
  const literal =
    typeof ORCA_RELEASE_SOURCES !== 'undefined'
      ? ORCA_RELEASE_SOURCES
      : Object.getOwnPropertyDescriptor(globalThis, 'ORCA_RELEASE_SOURCES')?.value
  return typeof literal === 'string' && literal.length > 0 ? literal : null
}

function loadReleaseSources(): readonly ReleaseSource[] {
  const literal = readReleaseSourcesLiteral()
  if (literal === null) {
    return DEFAULT_RELEASE_SOURCES
  }
  try {
    return parseReleaseSources(literal)
  } catch (error) {
    // Why: the build validated this literal, so a failure here is tampering or a packaging bug;
    // updating from the default source beats an app that cannot update at all.
    console.error('[release-sources] ignoring invalid ORCA_RELEASE_SOURCES define:', error)
    return DEFAULT_RELEASE_SOURCES
  }
}

export const RELEASE_SOURCES: readonly ReleaseSource[] = loadReleaseSources()
export const PRIMARY_RELEASE_SOURCE: ReleaseSource = RELEASE_SOURCES[0]

export function isMultiSourceBuild(): boolean {
  return RELEASE_SOURCES.length > 1
}

export function getReleaseSource(id: string): ReleaseSource | null {
  return RELEASE_SOURCES.find((source) => source.id === id) ?? null
}

export function getReleaseSourceOrPrimary(id: ReleaseSourceId | null | undefined): ReleaseSource {
  return (id ? getReleaseSource(id) : null) ?? PRIMARY_RELEASE_SOURCE
}

/**
 * The identifier that names a version's source: the first prerelease identifier,
 * skipping an `rc.N` base (`1.4.198-rc.1.swaplabs.<stamp>` keeps upstream's rc tail).
 */
function readSourceIdentifier(version: string): string | null {
  const match = version
    .trim()
    .replace(/^v/i, '')
    .match(/^\d+\.\d+\.\d+-([0-9A-Za-z-.]+)(?:\+[0-9A-Za-z-.]+)?$/)
  if (!match) {
    return null
  }
  const identifiers = match[1].split('.')
  if (identifiers[0] === 'rc' && /^\d+$/.test(identifiers[1] ?? '')) {
    identifiers.splice(0, 2)
  }
  return identifiers[0] ?? null
}

/** Which source published a version, or null when it is not a version at all. */
export function getVersionReleaseSource(version: string): ReleaseSourceId | null {
  if (!isValidAppVersion(version)) {
    return null
  }
  const identifier = readSourceIdentifier(version)
  const source = RELEASE_SOURCES.find(
    (candidate) =>
      candidate.prereleaseIdentifier !== null && candidate.prereleaseIdentifier === identifier
  )
  return source?.id ?? PRIMARY_RELEASE_SOURCE.id
}

/**
 * `1.4.197-swaplabs.202609241530[.delta…]` — the minute stamp orders a source's
 * builds among themselves; anything after it is free-form delta identifiers.
 * Null for the primary source, whose versions carry no stamp.
 */
export function getReleaseSourceVersionPattern(source: ReleaseSource): RegExp | null {
  if (source.prereleaseIdentifier === null) {
    return null
  }
  const identifier = escapeRegex(source.prereleaseIdentifier)
  return new RegExp(
    `^\\d+\\.\\d+\\.\\d+(?:-rc\\.\\d+\\.|-)${identifier}\\.(\\d{4})(\\d{2})(\\d{2})(\\d{2})(\\d{2})(?:\\.[0-9A-Za-z-]+)*$`
  )
}
