import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { compareAppVersions } from '../../../shared/app-version'
import type { MacSelfUpdateHelperOutcome } from './mac-self-update-helper'
import type { MacSelfUpdatePaths } from './mac-self-update-paths'

/** Written just before the helper starts; the next launch reads it to say how the swap went. */
export type MacSelfUpdateInstallState = {
  schemaVersion: 1
  phase: 'install-requested'
  fromVersion: string
  targetVersion: string
  stagedAppPath: string
  /** `helper` relaunches and health-checks; `supervisor` means the serve supervisor relaunches. */
  relaunchOwner: 'helper' | 'supervisor'
  requestedAt: string
}

export type MacSelfUpdateLaunchOutcome =
  | { kind: 'none' }
  | { kind: 'completed'; fromVersion: string; targetVersion: string; helperOutcome: string | null }
  | {
      kind: 'failed'
      fromVersion: string
      targetVersion: string
      helperOutcome: string | null
      message: string
    }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function parseMacSelfUpdateInstallState(value: unknown): MacSelfUpdateInstallState | null {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    value.phase !== 'install-requested' ||
    typeof value.fromVersion !== 'string' ||
    typeof value.targetVersion !== 'string' ||
    typeof value.stagedAppPath !== 'string' ||
    (value.relaunchOwner !== 'helper' && value.relaunchOwner !== 'supervisor') ||
    typeof value.requestedAt !== 'string'
  ) {
    return null
  }
  return {
    schemaVersion: 1,
    phase: 'install-requested',
    fromVersion: value.fromVersion,
    targetVersion: value.targetVersion,
    stagedAppPath: value.stagedAppPath,
    relaunchOwner: value.relaunchOwner,
    requestedAt: value.requestedAt
  }
}

/** Atomic (temp file + rename), like the serve handoff, so a crash mid-write leaves no half state. */
export function writeMacSelfUpdateInstallState(
  path: string,
  state: MacSelfUpdateInstallState
): void {
  mkdirSync(dirname(path), { recursive: true })
  const temporaryPath = `${path}.${process.pid}.tmp`
  writeFileSync(temporaryPath, JSON.stringify(state), { mode: 0o600 })
  renameSync(temporaryPath, path)
}

export function readMacSelfUpdateInstallState(path: string): MacSelfUpdateInstallState | null {
  try {
    return parseMacSelfUpdateInstallState(JSON.parse(readFileSync(path, 'utf8')))
  } catch {
    return null
  }
}

/** The one word the helper wrote, or null when it never got to write one. */
export function readMacSelfUpdateHelperOutcome(path: string): string | null {
  try {
    return readFileSync(path, 'utf8').trim() || null
  } catch {
    return null
  }
}

const HELPER_OUTCOME_MESSAGES: Record<MacSelfUpdateHelperOutcome, string> = {
  healthy: 'the update was applied',
  swapped: 'the update was applied',
  'rolled-back':
    'the new build did not start within its time limit, so the previous build was restored',
  'relaunch-failed': 'the new build could not be launched, so the previous build was restored',
  'rename-staged-failed': 'the downloaded build could not be moved into place',
  'rename-current-failed': 'the installed app could not be moved aside',
  'rollback-dir-failed': 'no rollback folder could be created next to the app',
  'staged-missing': 'the downloaded build was gone by the time the helper ran',
  'app-still-running': 'the previous build never exited'
}

function isKnownHelperOutcome(outcome: string): outcome is MacSelfUpdateHelperOutcome {
  return Object.hasOwn(HELPER_OUTCOME_MESSAGES, outcome)
}

function describeHelperOutcome(outcome: string | null): string {
  if (outcome === null) {
    return 'the update helper left no record'
  }
  return isKnownHelperOutcome(outcome) ? HELPER_OUTCOME_MESSAGES[outcome] : outcome
}

/**
 * Decides what the previous launch's install request came to, from the version now running:
 * the target means success, the previous version means a rollback or a swap that never
 * happened, anything else is somebody else's launch.
 */
export function resolveMacSelfUpdateLaunchOutcome(
  state: MacSelfUpdateInstallState | null,
  runningVersion: string,
  helperOutcome: string | null
): MacSelfUpdateLaunchOutcome {
  if (!state) {
    return { kind: 'none' }
  }
  const base = {
    fromVersion: state.fromVersion,
    targetVersion: state.targetVersion,
    helperOutcome
  }
  if (compareAppVersions(runningVersion, state.targetVersion) === 0) {
    return { kind: 'completed', ...base }
  }
  const restored = compareAppVersions(runningVersion, state.fromVersion) === 0
  return {
    kind: 'failed',
    ...base,
    message: restored
      ? `Orca could not update to ${state.targetVersion}: ${describeHelperOutcome(helperOutcome)}. You are still running ${state.fromVersion}.`
      : `Orca ${runningVersion} started while an update to ${state.targetVersion} was pending: ${describeHelperOutcome(helperOutcome)}.`
  }
}

/** The health marker is the file the helper polls; its content is only for a human reading the folder. */
export function writeMacSelfUpdateHealthMarker(path: string, version: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${version}\n`, { mode: 0o600 })
}

/** Removes the request, the helper's record and the marker, so a later launch does not re-report it. */
export function clearMacSelfUpdateInstallRecords(
  paths: MacSelfUpdatePaths,
  options: { keepHealthMarker?: boolean } = {}
): void {
  const records = [paths.installStatePath, paths.helperOutcomePath]
  if (!options.keepHealthMarker) {
    records.push(paths.healthMarkerPath)
  }
  for (const path of records) {
    rmSync(path, { force: true })
  }
}

/** Removes leftover downloads and a staged bundle that never got installed. Never touches the rollback. */
export function pruneMacSelfUpdateWorkDirs(paths: MacSelfUpdatePaths): void {
  for (const dir of [paths.downloadsDir, paths.stagingDir]) {
    rmSync(dir, { recursive: true, force: true })
  }
}

export function pruneMacSelfUpdateRollback(paths: MacSelfUpdatePaths): void {
  rmSync(dirname(paths.rollbackAppPath), { recursive: true, force: true })
}
