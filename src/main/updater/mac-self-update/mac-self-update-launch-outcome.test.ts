import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { writeMacSelfUpdateInstallState } from './mac-self-update-install-state'
import { resolveMacSelfUpdatePaths, type MacSelfUpdatePaths } from './mac-self-update-paths'

const launch = vi.hoisted((): { runningVersion: string; paths: MacSelfUpdatePaths | null } => ({
  runningVersion: '',
  paths: null
}))

vi.mock('electron', () => ({
  app: { isPackaged: true, getVersion: () => launch.runningVersion }
}))
vi.mock('./mac-self-update-activation', () => ({
  getMacSelfUpdateSupport: () => ({ supported: true }),
  resolveRunningMacSelfUpdatePaths: () => {
    if (!launch.paths) {
      throw new Error('no paths for this test')
    }
    return launch.paths
  }
}))
const recordUpdaterLifecycleMock = vi.hoisted(() => vi.fn())
vi.mock('../../updater-lifecycle-diagnostics', () => ({
  recordUpdaterLifecycle: recordUpdaterLifecycleMock
}))

const FROM_VERSION = '1.4.197-swaplabs.202609241530'
const TARGET_VERSION = '1.4.197-swaplabs.202609251200'

describe('mac self-update launch outcome', () => {
  let dir = ''
  let platformSpy: { mockRestore(): void } | null = null

  beforeEach(() => {
    vi.resetModules()
    platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    dir = mkdtempSync(join(tmpdir(), 'orca-mac-self-update-launch-'))
    launch.paths = resolveMacSelfUpdatePaths({
      executablePath: join(dir, 'Applications', 'Orca.app', 'Contents', 'MacOS', 'Orca'),
      userDataPath: join(dir, 'userData')
    })
    writeMacSelfUpdateInstallState(launch.paths.installStatePath, {
      schemaVersion: 1,
      phase: 'install-requested',
      fromVersion: FROM_VERSION,
      targetVersion: TARGET_VERSION,
      stagedAppPath: launch.paths.stagingDir,
      requestedAt: '2026-09-28T10:00:00Z'
    })
  })

  afterEach(() => {
    vi.useRealTimers()
    recordUpdaterLifecycleMock.mockReset()
    platformSpy?.mockRestore()
    rmSync(dir, { recursive: true, force: true })
  })

  const loadModule = () => import('./mac-self-update-launch-outcome')

  // Why: the updater sets up from a 15 s crash-loop fallback when the renderer never shows, and
  // that setup used to write the health marker, so the helper kept a build with no usable window.
  it('reads the previous failure without signalling health; the first window signals it', async () => {
    launch.runningVersion = TARGET_VERSION
    const { getMacSelfUpdateLaunchFailure, reportMacSelfUpdateLaunchOutcome } = await loadModule()

    expect(getMacSelfUpdateLaunchFailure()).toBeNull()
    expect(existsSync(launch.paths!.healthMarkerPath)).toBe(false)
    expect(existsSync(launch.paths!.installStatePath)).toBe(true)

    expect(reportMacSelfUpdateLaunchOutcome()).toMatchObject({
      kind: 'completed',
      targetVersion: TARGET_VERSION
    })
    expect(existsSync(launch.paths!.healthMarkerPath)).toBe(true)
    expect(existsSync(launch.paths!.installStatePath)).toBe(false)
  })

  // Why: the helper rolls this healthy build back when the marker is missing at its deadline,
  // and one refused write used to be the end of it; the outcome was cached and never retried.
  it('keeps trying to write the health marker while the helper is still waiting', async () => {
    vi.useFakeTimers()
    launch.runningVersion = TARGET_VERSION
    // A folder where the marker file goes: the first write is refused (EISDIR).
    mkdirSync(launch.paths!.healthMarkerPath, { recursive: true })
    const { HEALTH_MARKER_RETRY_MS, reportMacSelfUpdateLaunchOutcome } = await loadModule()

    expect(reportMacSelfUpdateLaunchOutcome()).toMatchObject({ kind: 'completed' })
    expect(statSync(launch.paths!.healthMarkerPath).isDirectory()).toBe(true)
    expect(recordUpdaterLifecycleMock).toHaveBeenCalledWith(
      'mac_self_update_health_marker_failed',
      expect.objectContaining({ attempt: 1 }),
      expect.objectContaining({ level: 'warn' })
    )
    // The rest of the report still ran: the request is cleared and the completion recorded.
    expect(existsSync(launch.paths!.installStatePath)).toBe(false)
    expect(recordUpdaterLifecycleMock).toHaveBeenCalledWith(
      'mac_self_update_completed',
      expect.objectContaining({ to: TARGET_VERSION })
    )

    rmSync(launch.paths!.healthMarkerPath, { recursive: true })
    vi.advanceTimersByTime(HEALTH_MARKER_RETRY_MS)
    expect(statSync(launch.paths!.healthMarkerPath).isFile()).toBe(true)
    expect(recordUpdaterLifecycleMock).toHaveBeenCalledWith(
      'mac_self_update_health_marker_written',
      { attempt: 2 }
    )
  })

  // Why: when the helper cannot restore the previous build it relaunches the new one, so the
  // build that missed its health deadline can be the one reporting. The update did apply, so it
  // is not a failure to show; the helper's verdict is kept in the record, at warning level.
  it('records a build the helper gave up on as completed, with the verdict, not as a failure', async () => {
    vi.useFakeTimers()
    launch.runningVersion = TARGET_VERSION
    writeFileSync(launch.paths!.helperOutcomePath, 'rollback-blocked\n')
    mkdirSync(launch.paths!.rollbackAppPath, { recursive: true })
    const {
      ROLLBACK_PRUNE_DELAY_MS,
      getMacSelfUpdateLaunchFailure,
      reportMacSelfUpdateLaunchOutcome
    } = await loadModule()

    expect(reportMacSelfUpdateLaunchOutcome()).toMatchObject({
      kind: 'completed',
      helperOutcome: 'rollback-blocked'
    })
    expect(getMacSelfUpdateLaunchFailure()).toBeNull()
    expect(recordUpdaterLifecycleMock).toHaveBeenCalledWith(
      'mac_self_update_completed',
      expect.objectContaining({ to: TARGET_VERSION, helperOutcome: 'rollback-blocked' }),
      {
        level: 'warn',
        message: expect.stringContaining('the app folder was still occupied')
      }
    )
    expect(recordUpdaterLifecycleMock).not.toHaveBeenCalledWith(
      'mac_self_update_failed',
      expect.anything(),
      expect.anything()
    )
    expect(existsSync(launch.paths!.healthMarkerPath)).toBe(true)
    // The rollback copy has no watcher once the helper has exited; it goes like any other.
    vi.advanceTimersByTime(ROLLBACK_PRUNE_DELAY_MS + 1)
    expect(existsSync(launch.paths!.rollbackAppPath)).toBe(false)
  })

  it('shows the same failure before and after the launch is reported', async () => {
    launch.runningVersion = FROM_VERSION
    writeFileSync(launch.paths!.helperOutcomePath, 'rolled-back\n')
    const { getMacSelfUpdateLaunchFailure, reportMacSelfUpdateLaunchOutcome } = await loadModule()

    const failure = getMacSelfUpdateLaunchFailure()
    expect(failure).toContain(`could not update to ${TARGET_VERSION}`)
    expect(failure).toContain('the previous build was restored')
    expect(existsSync(launch.paths!.installStatePath)).toBe(true)

    expect(reportMacSelfUpdateLaunchOutcome()).toMatchObject({ kind: 'failed', message: failure })
    expect(existsSync(launch.paths!.healthMarkerPath)).toBe(false)
    expect(existsSync(launch.paths!.installStatePath)).toBe(false)
    expect(getMacSelfUpdateLaunchFailure()).toBe(failure)
  })
})
