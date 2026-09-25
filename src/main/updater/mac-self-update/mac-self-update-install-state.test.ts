import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  clearMacSelfUpdateInstallRecords,
  parseMacSelfUpdateInstallState,
  pruneMacSelfUpdateRollback,
  pruneMacSelfUpdateWorkDirs,
  readMacSelfUpdateHelperOutcome,
  readMacSelfUpdateInstallState,
  resolveMacSelfUpdateLaunchOutcome,
  writeMacSelfUpdateHealthMarker,
  writeMacSelfUpdateInstallState,
  type MacSelfUpdateInstallState
} from './mac-self-update-install-state'
import { resolveMacSelfUpdatePaths } from './mac-self-update-paths'

const STATE: MacSelfUpdateInstallState = {
  schemaVersion: 1,
  phase: 'install-requested',
  fromVersion: '1.4.197-swaplabs.202609241530',
  targetVersion: '1.4.197-swaplabs.202609251200',
  stagedAppPath: '/Applications/.Orca-update-staging/Orca.app',
  relaunchOwner: 'helper',
  requestedAt: '2026-09-25T12:00:00.000Z'
}

describe('install state file', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'orca-mac-self-update-state-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('round-trips through disk and rejects anything but the known shape', () => {
    const path = join(dir, 'nested', 'install-state.json')
    writeMacSelfUpdateInstallState(path, STATE)
    expect(readMacSelfUpdateInstallState(path)).toEqual(STATE)
    expect(existsSync(`${path}.${process.pid}.tmp`)).toBe(false)
    expect(readMacSelfUpdateInstallState(join(dir, 'missing.json'))).toBeNull()
    writeFileSync(path, '{not json')
    expect(readMacSelfUpdateInstallState(path)).toBeNull()
    expect(parseMacSelfUpdateInstallState({ ...STATE, phase: 'done' })).toBeNull()
    expect(parseMacSelfUpdateInstallState({ ...STATE, relaunchOwner: 'me' })).toBeNull()
    expect(parseMacSelfUpdateInstallState({ ...STATE, schemaVersion: 2 })).toBeNull()
  })

  it('writes the health marker and reads the helper outcome word', () => {
    const marker = join(dir, 'launch-healthy')
    writeMacSelfUpdateHealthMarker(marker, STATE.targetVersion)
    expect(readFileSync(marker, 'utf8')).toBe(`${STATE.targetVersion}\n`)
    const outcome = join(dir, 'helper-outcome')
    expect(readMacSelfUpdateHelperOutcome(outcome)).toBeNull()
    writeFileSync(outcome, 'healthy\n')
    expect(readMacSelfUpdateHelperOutcome(outcome)).toBe('healthy')
  })

  it('clears the records, optionally keeping the marker, and prunes work and rollback dirs', () => {
    const paths = resolveMacSelfUpdatePaths({
      executablePath: join(dir, 'Applications', 'Orca.app', 'Contents', 'MacOS', 'Orca'),
      userDataPath: join(dir, 'userData')
    })
    for (const path of [paths.installStatePath, paths.helperOutcomePath, paths.healthMarkerPath]) {
      mkdirSync(join(path, '..'), { recursive: true })
      writeFileSync(path, 'x')
    }
    mkdirSync(join(paths.stagingDir, 'Orca.app'), { recursive: true })
    mkdirSync(paths.downloadsDir, { recursive: true })
    mkdirSync(paths.rollbackAppPath, { recursive: true })

    clearMacSelfUpdateInstallRecords(paths, { keepHealthMarker: true })
    expect(existsSync(paths.installStatePath)).toBe(false)
    expect(existsSync(paths.helperOutcomePath)).toBe(false)
    expect(existsSync(paths.healthMarkerPath)).toBe(true)
    clearMacSelfUpdateInstallRecords(paths)
    expect(existsSync(paths.healthMarkerPath)).toBe(false)

    pruneMacSelfUpdateWorkDirs(paths)
    expect(existsSync(paths.stagingDir)).toBe(false)
    expect(existsSync(paths.downloadsDir)).toBe(false)
    expect(existsSync(paths.rollbackAppPath)).toBe(true)
    pruneMacSelfUpdateRollback(paths)
    expect(existsSync(join(paths.rollbackAppPath, '..'))).toBe(false)
  })
})

describe('resolveMacSelfUpdateLaunchOutcome', () => {
  it('is nothing without a pending request', () => {
    expect(resolveMacSelfUpdateLaunchOutcome(null, '1.0.0', 'healthy')).toEqual({ kind: 'none' })
  })

  it('completes when the target version is the one running', () => {
    expect(resolveMacSelfUpdateLaunchOutcome(STATE, STATE.targetVersion, null)).toEqual({
      kind: 'completed',
      fromVersion: STATE.fromVersion,
      targetVersion: STATE.targetVersion,
      helperOutcome: null
    })
  })

  it("reports a rollback in the previous build's words, naming what the helper recorded", () => {
    const outcome = resolveMacSelfUpdateLaunchOutcome(STATE, STATE.fromVersion, 'rolled-back')
    expect(outcome).toMatchObject({ kind: 'failed', helperOutcome: 'rolled-back' })
    expect(outcome.kind === 'failed' && outcome.message).toBe(
      `Orca could not update to ${STATE.targetVersion}: the new build did not start within its time limit, so the previous build was restored. You are still running ${STATE.fromVersion}.`
    )
    const silent = resolveMacSelfUpdateLaunchOutcome(STATE, STATE.fromVersion, null)
    expect(silent.kind === 'failed' && silent.message).toContain('left no record')
    const unknownWord = resolveMacSelfUpdateLaunchOutcome(STATE, STATE.fromVersion, 'weird')
    expect(unknownWord.kind === 'failed' && unknownWord.message).toContain(': weird.')
  })

  it('flags a third version as a launch that is not the requested one', () => {
    const outcome = resolveMacSelfUpdateLaunchOutcome(STATE, '1.4.199', 'healthy')
    expect(outcome.kind === 'failed' && outcome.message).toContain('started while an update to')
  })
})
