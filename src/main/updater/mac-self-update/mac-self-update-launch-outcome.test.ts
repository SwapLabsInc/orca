import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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
vi.mock('../../updater-lifecycle-diagnostics', () => ({ recordUpdaterLifecycle: vi.fn() }))

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
      relaunchOwner: 'helper',
      requestedAt: '2026-09-28T10:00:00Z'
    })
  })

  afterEach(() => {
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
