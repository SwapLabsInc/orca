import { spawn, type ChildProcess } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  MAC_SELF_UPDATE_HELPER_ARGV0,
  MAC_SELF_UPDATE_HELPER_SCRIPT,
  MAC_SELF_UPDATE_HELPER_SHELL,
  buildMacSelfUpdateHelperArgs,
  spawnMacSelfUpdateHelper,
  type MacSelfUpdateHelperPlan
} from './mac-self-update-helper'

const describePosix = process.platform === 'win32' ? describe.skip : describe

type Scenario = {
  dir: string
  plan: MacSelfUpdateHelperPlan
  appProcess: ChildProcess
  relaunchLog: string
  /** Where the relaunch script records the pid of the stubborn "new app" it started, if asked to. */
  newAppPidFile: string
  /** PATH for the helper; a scenario that hooks `mv` puts its wrapper first. */
  env: NodeJS.ProcessEnv
}

type ScenarioOptions = {
  healthy: boolean
  relaunch?: boolean
  staged?: boolean
  /** What the relaunch program exits with; a non-zero code fails every launch attempt. */
  relaunchExitCode?: number
  /** Shell lines the relaunch program runs on its first call only, after logging: the new build "running". */
  onFirstRelaunch?: string[]
  /** A shell line the concurrent actor runs right after `mv` has moved the app aside, once. */
  afterAppMovedAside?: string
  /** The first relaunch starts a process posing as the new build's executable that ignores SIGTERM. */
  newAppIgnoresSigterm?: boolean
}

/**
 * A real swap over a temp tree: the "app" is a directory with a marker file, the running
 * app process is a `sleep`, and the relaunch program is a script that logs its argument and,
 * when told to, writes the health marker a moment later like a healthy launch would.
 */
function createScenario(options: ScenarioOptions): Scenario {
  const dir = mkdtempSync(join(tmpdir(), 'orca-mac-self-update-helper-'))
  const appPath = join(dir, 'Applications', 'Orca.app')
  const stagedAppPath = join(dir, 'Applications', '.Orca-update-staging', 'Orca.app')
  const rollbackAppPath = join(dir, 'Applications', '.Orca-update-rollback', 'Orca.app')
  const stateDir = join(dir, 'state')
  mkdirSync(join(appPath, 'Contents', 'MacOS'), { recursive: true })
  writeFileSync(join(appPath, 'Contents', 'MacOS', 'Orca'), 'old build')
  if (options.staged !== false) {
    mkdirSync(join(stagedAppPath, 'Contents', 'MacOS'), { recursive: true })
    writeFileSync(join(stagedAppPath, 'Contents', 'MacOS', 'Orca'), 'new build')
  }
  mkdirSync(stateDir, { recursive: true })
  const relaunchLog = join(stateDir, 'relaunch.log')
  const healthMarkerPath = join(stateDir, 'launch-healthy')
  const relaunchProgram = join(stateDir, 'relaunch.sh')
  const firstRelaunchFlag = join(stateDir, 'relaunched-once')
  const newAppPidFile = join(stateDir, 'new-app.pid')
  const onFirstRelaunch = [...(options.onFirstRelaunch ?? [])]
  if (options.newAppIgnoresSigterm) {
    const stubbornScript = join(stateDir, 'stubborn-new-app.cjs')
    writeFileSync(
      stubbornScript,
      [
        '// Test-only: pose as the new build on the process table and ignore SIGTERM.',
        'process.title = process.argv[2]',
        'process.on("SIGTERM", () => {})',
        'setInterval(() => {}, 1000)',
        ''
      ].join('\n')
    )
    onFirstRelaunch.push(
      `"${process.execPath}" "${stubbornScript}" "$1/Contents/MacOS/Orca" </dev/null >/dev/null 2>&1 &`,
      `printf '%s\\n' "$!" > "${newAppPidFile}"`
    )
  }
  writeFileSync(
    relaunchProgram,
    [
      '#!/bin/sh',
      `printf '%s\\n' "$1" >> "${relaunchLog}"`,
      options.healthy ? `(sleep 1; printf 'ok\\n' > "${healthMarkerPath}") &` : '',
      ...(onFirstRelaunch.length > 0
        ? [
            `if [ ! -e "${firstRelaunchFlag}" ]; then`,
            `  : > "${firstRelaunchFlag}"`,
            ...onFirstRelaunch,
            'fi'
          ]
        : []),
      `exit ${options.relaunchExitCode ?? 0}`,
      ''
    ].join('\n')
  )
  chmodSync(relaunchProgram, 0o755)
  let env = process.env
  if (options.afterAppMovedAside) {
    // Why a wrapper on PATH: nothing else runs between the helper's two renames, so the actor
    // that reoccupies the app's slot can only be simulated from inside `mv` itself.
    const binDir = join(stateDir, 'bin')
    mkdirSync(binDir)
    const hookFlag = join(stateDir, 'moved-aside-once')
    writeFileSync(
      join(binDir, 'mv'),
      [
        '#!/bin/sh',
        '/bin/mv "$@"',
        'status=$?',
        `if [ "$status" -eq 0 ] && [ "$1" = "${appPath}" ] && [ ! -e "${hookFlag}" ]; then`,
        `  : > "${hookFlag}"`,
        `  ${options.afterAppMovedAside}`,
        'fi',
        'exit $status',
        ''
      ].join('\n')
    )
    chmodSync(join(binDir, 'mv'), 0o755)
    env = { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ''}` }
  }
  const appProcess = spawn('sleep', ['30'], { stdio: 'ignore' })
  return {
    dir,
    relaunchLog,
    appProcess,
    newAppPidFile,
    env,
    plan: {
      appPid: appProcess.pid ?? -1,
      appPath,
      stagedAppPath,
      rollbackAppPath,
      healthMarkerPath,
      outcomePath: join(stateDir, 'helper-outcome'),
      executableRelativePath: 'Contents/MacOS/Orca',
      relaunchProgram: options.relaunch === false ? null : relaunchProgram,
      healthTimeoutSeconds: 2
    }
  }
}

function runHelper(scenario: Scenario): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const child = spawn(MAC_SELF_UPDATE_HELPER_SHELL, buildMacSelfUpdateHelperArgs(scenario.plan), {
      stdio: 'ignore',
      env: scenario.env
    })
    child.once('error', reject)
    child.once('close', (code) => resolve(code))
  })
}

/** The pid the relaunch script recorded for the stubborn new app, or null when it started none. */
function newAppPid(scenario: Scenario): number | null {
  if (!existsSync(scenario.newAppPidFile)) {
    return null
  }
  const pid = Number.parseInt(readFileSync(scenario.newAppPidFile, 'utf8'), 10)
  return Number.isInteger(pid) && pid > 0 ? pid : null
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const bundleMarker = (appPath: string): string =>
  readFileSync(join(appPath, 'Contents', 'MacOS', 'Orca'), 'utf8')
const outcomeOf = (plan: MacSelfUpdateHelperPlan): string =>
  readFileSync(plan.outcomePath, 'utf8').trim()

describe('helper argv', () => {
  it('hands /bin/sh the static script and every path as its own argument', () => {
    const plan: MacSelfUpdateHelperPlan = {
      appPid: 77,
      appPath: '/Applications/Orca (SwapLabs).app',
      stagedAppPath: '/Applications/.Orca (SwapLabs)-update-staging/Orca.app',
      rollbackAppPath: '/Applications/.Orca (SwapLabs)-update-rollback/Orca (SwapLabs).app',
      healthMarkerPath: '/Users/me/Library/Application Support/Orca/mac-self-update/launch-healthy',
      outcomePath: '/Users/me/Library/Application Support/Orca/mac-self-update/helper-outcome',
      executableRelativePath: 'Contents/MacOS/Orca',
      relaunchProgram: '/usr/bin/open',
      healthTimeoutSeconds: 90
    }
    const args = buildMacSelfUpdateHelperArgs(plan)
    expect(args.slice(0, 3)).toEqual([
      '-c',
      MAC_SELF_UPDATE_HELPER_SCRIPT,
      MAC_SELF_UPDATE_HELPER_ARGV0
    ])
    expect(args.slice(3)).toEqual([
      '77',
      plan.appPath,
      plan.stagedAppPath,
      plan.rollbackAppPath,
      plan.healthMarkerPath,
      '/usr/bin/open',
      '90',
      plan.outcomePath,
      'Contents/MacOS/Orca'
    ])
    // The script is the same bytes for every install: no path, version or user text inside it.
    expect(MAC_SELF_UPDATE_HELPER_SCRIPT).not.toContain('/Applications')
    expect(MAC_SELF_UPDATE_HELPER_SCRIPT).not.toContain('${')
    expect(MAC_SELF_UPDATE_HELPER_SCRIPT).not.toMatch(
      /\b(?:eval|osascript|python|perl|ruby|node)\b/
    )
  })

  const spawnPlan: MacSelfUpdateHelperPlan = {
    appPid: 1,
    appPath: '/a/Orca.app',
    stagedAppPath: '/a/.Orca-update-staging/Orca.app',
    rollbackAppPath: '/a/.Orca-update-rollback/Orca.app',
    healthMarkerPath: '/s/launch-healthy',
    outcomePath: '/s/helper-outcome',
    executableRelativePath: 'Contents/MacOS/Orca',
    relaunchProgram: null,
    healthTimeoutSeconds: 90
  }

  it('spawns detached through the injected spawner and unrefs the child', () => {
    const unref = vi.fn()
    const spawner = vi.fn(() => ({ pid: 99, unref, on: vi.fn() }))
    const pid = spawnMacSelfUpdateHelper(spawnPlan, spawner)
    expect(pid).toBe(99)
    expect(spawner).toHaveBeenCalledWith(MAC_SELF_UPDATE_HELPER_SHELL, expect.any(Array))
    expect(unref).toHaveBeenCalledTimes(1)
    expect(() =>
      spawnMacSelfUpdateHelper(spawnPlan, () => ({ pid: undefined, unref, on: vi.fn() }))
    ).toThrow(/did not start/)
  })

  // Why a real spawn: Node reports a refused one as a pid-less child whose `error` fires a tick
  // later, and an `error` nobody listens for is an uncaught exception in the main process.
  it('hears the late error of a spawn the system refused, and passes its cause on', async () => {
    const spawned: ChildProcess[] = []
    const causes: Error[] = []
    expect(() =>
      spawnMacSelfUpdateHelper(
        spawnPlan,
        (_program, args) => {
          const child = spawn(join(tmpdir(), 'orca-mac-self-update-no-such-shell'), args, {
            detached: true,
            stdio: 'ignore'
          })
          spawned.push(child)
          return child
        },
        (error) => causes.push(error)
      )
    ).toThrow(/did not start/)
    expect(spawned[0].pid).toBeUndefined()
    expect(spawned[0].listenerCount('error')).toBe(1)
    await vi.waitFor(() => expect(causes).toHaveLength(1))
    expect(causes[0]).toMatchObject({ code: 'ENOENT' })
  })
})

describePosix('helper script (real /bin/sh over a temp tree)', () => {
  const scenarios: Scenario[] = []

  afterEach(() => {
    for (const scenario of scenarios.splice(0)) {
      scenario.appProcess.kill('SIGKILL')
      const stubborn = newAppPid(scenario)
      if (stubborn !== null && isProcessAlive(stubborn)) {
        process.kill(stubborn, 'SIGKILL')
      }
      rmSync(scenario.dir, { recursive: true, force: true })
    }
  })

  it('parses under sh -n', async () => {
    const code = await new Promise<number | null>((resolve) => {
      spawn(MAC_SELF_UPDATE_HELPER_SHELL, ['-n', '-c', MAC_SELF_UPDATE_HELPER_SCRIPT], {
        stdio: 'ignore'
      }).once('close', resolve)
    })
    expect(code).toBe(0)
  })

  it('waits for the app to exit, swaps the bundles, relaunches and reports healthy', async () => {
    const scenario = createScenario({ healthy: true })
    scenarios.push(scenario)
    const helper = runHelper(scenario)
    // The helper must not touch the bundle while the app is alive.
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(bundleMarker(scenario.plan.appPath)).toBe('old build')
    scenario.appProcess.kill('SIGKILL')

    expect(await helper).toBe(0)
    expect(outcomeOf(scenario.plan)).toBe('healthy')
    expect(bundleMarker(scenario.plan.appPath)).toBe('new build')
    expect(bundleMarker(scenario.plan.rollbackAppPath)).toBe('old build')
    expect(existsSync(scenario.plan.stagedAppPath)).toBe(false)
    expect(readFileSync(scenario.relaunchLog, 'utf8')).toBe(`${scenario.plan.appPath}\n`)
  }, 20_000)

  it('restores the previous bundle and relaunches it when no health marker appears in time', async () => {
    const scenario = createScenario({ healthy: false })
    scenarios.push(scenario)
    scenario.appProcess.kill('SIGKILL')

    expect(await runHelper(scenario)).toBe(1)
    expect(outcomeOf(scenario.plan)).toBe('rolled-back')
    expect(bundleMarker(scenario.plan.appPath)).toBe('old build')
    // The build that never came up goes back to staging for the next launch to discard.
    expect(bundleMarker(scenario.plan.stagedAppPath)).toBe('new build')
    expect(existsSync(scenario.plan.rollbackAppPath)).toBe(false)
    expect(readFileSync(scenario.relaunchLog, 'utf8')).toBe(
      `${scenario.plan.appPath}\n${scenario.plan.appPath}\n`
    )
  }, 20_000)

  it('only swaps when a supervisor owns the relaunch', async () => {
    const scenario = createScenario({ healthy: false, relaunch: false })
    scenarios.push(scenario)
    scenario.appProcess.kill('SIGKILL')

    expect(await runHelper(scenario)).toBe(0)
    expect(outcomeOf(scenario.plan)).toBe('swapped')
    expect(bundleMarker(scenario.plan.appPath)).toBe('new build')
    expect(existsSync(scenario.relaunchLog)).toBe(false)
  }, 20_000)

  // Why: the app has quit by the time the helper runs, so a failure that leaves the old bundle
  // in place must start it again or the user is left with no Orca at all.
  it('relaunches the untouched app when the staged bundle is missing', async () => {
    const scenario = createScenario({ healthy: true, staged: false })
    scenarios.push(scenario)
    scenario.appProcess.kill('SIGKILL')

    expect(await runHelper(scenario)).toBe(1)
    expect(outcomeOf(scenario.plan)).toBe('staged-missing')
    expect(bundleMarker(scenario.plan.appPath)).toBe('old build')
    expect(readFileSync(scenario.relaunchLog, 'utf8')).toBe(`${scenario.plan.appPath}\n`)
  }, 20_000)

  it('leaves the relaunch to the supervisor when the staged bundle is missing', async () => {
    const scenario = createScenario({ healthy: true, staged: false, relaunch: false })
    scenarios.push(scenario)
    scenario.appProcess.kill('SIGKILL')

    expect(await runHelper(scenario)).toBe(1)
    expect(outcomeOf(scenario.plan)).toBe('staged-missing')
    expect(existsSync(scenario.relaunchLog)).toBe(false)
  }, 20_000)

  // Why: `mv` onto a directory that survived `rm -rf` moves the app inside it, so the rollback
  // would hold a bundle nested in the leftovers and restoring it would leave no runnable Orca.
  it.skipIf(process.getuid?.() === 0)(
    'leaves the app in place and relaunches it when the previous rollback cannot be removed',
    async () => {
      const scenario = createScenario({ healthy: true })
      scenarios.push(scenario)
      scenario.appProcess.kill('SIGKILL')
      const leftover = join(scenario.plan.rollbackAppPath, 'Contents')
      mkdirSync(leftover, { recursive: true })
      writeFileSync(join(leftover, 'Info.plist'), 'older build')
      // A read-only directory refuses to give up its entries, so `rm -rf` fails below it.
      chmodSync(leftover, 0o555)
      try {
        expect(await runHelper(scenario)).toBe(1)
      } finally {
        chmodSync(leftover, 0o755)
      }
      expect(outcomeOf(scenario.plan)).toBe('rollback-dir-failed')
      expect(bundleMarker(scenario.plan.appPath)).toBe('old build')
      expect(bundleMarker(scenario.plan.stagedAppPath)).toBe('new build')
      expect(existsSync(join(scenario.plan.rollbackAppPath, 'Orca.app'))).toBe(false)
      expect(readFileSync(scenario.relaunchLog, 'utf8')).toBe(`${scenario.plan.appPath}\n`)
    },
    20_000
  )

  // Root ignores directory permissions, so the failure cannot be provoked there.
  it.skipIf(process.getuid?.() === 0)(
    'restores and relaunches the previous bundle when the staged one cannot be moved into place',
    async () => {
      const scenario = createScenario({ healthy: true })
      scenarios.push(scenario)
      scenario.appProcess.kill('SIGKILL')
      const stagingDir = join(scenario.plan.stagedAppPath, '..')
      // A read-only staging directory refuses to give up its entry, so the second mv fails.
      chmodSync(stagingDir, 0o555)
      try {
        expect(await runHelper(scenario)).toBe(1)
      } finally {
        chmodSync(stagingDir, 0o755)
      }
      expect(outcomeOf(scenario.plan)).toBe('rename-staged-failed')
      expect(bundleMarker(scenario.plan.appPath)).toBe('old build')
      expect(bundleMarker(scenario.plan.stagedAppPath)).toBe('new build')
      expect(existsSync(scenario.plan.rollbackAppPath)).toBe(false)
      expect(readFileSync(scenario.relaunchLog, 'utf8')).toBe(`${scenario.plan.appPath}\n`)
    },
    20_000
  )
  // Why: `mv` of the unhealthy build back to staging can fail (an ACL, a security tool, a folder
  // that vanished), and the restore used to run regardless — `mv` of the rollback onto the still
  // occupied app folder nested the good bundle inside the bad one and relaunched the bad one.
  it.skipIf(process.getuid?.() === 0)(
    'keeps the previous build in the rollback folder and relaunches the occupant when the unhealthy build cannot be moved aside',
    async () => {
      // The first relaunch is the new build "running": it makes staging refuse the move-aside.
      const scenario = createScenario({
        healthy: false,
        onFirstRelaunch: [`chmod 555 "$(dirname "$1")/.Orca-update-staging"`]
      })
      scenarios.push(scenario)
      scenario.appProcess.kill('SIGKILL')
      try {
        expect(await runHelper(scenario)).toBe(1)
      } finally {
        chmodSync(join(scenario.plan.stagedAppPath, '..'), 0o755)
      }
      expect(outcomeOf(scenario.plan)).toBe('rollback-blocked')
      expect(bundleMarker(scenario.plan.appPath)).toBe('new build')
      expect(existsSync(join(scenario.plan.appPath, 'Orca.app'))).toBe(false)
      expect(bundleMarker(scenario.plan.rollbackAppPath)).toBe('old build')
      expect(readFileSync(scenario.relaunchLog, 'utf8')).toBe(
        `${scenario.plan.appPath}\n${scenario.plan.appPath}\n`
      )
    },
    30_000
  )

  it.skipIf(process.getuid?.() === 0)(
    'keeps the previous build in the rollback folder when the build that would not launch cannot be moved aside',
    async () => {
      const scenario = createScenario({
        healthy: false,
        relaunchExitCode: 1,
        onFirstRelaunch: [`chmod 555 "$(dirname "$1")/.Orca-update-staging"`]
      })
      scenarios.push(scenario)
      scenario.appProcess.kill('SIGKILL')
      try {
        expect(await runHelper(scenario)).toBe(1)
      } finally {
        chmodSync(join(scenario.plan.stagedAppPath, '..'), 0o755)
      }
      expect(outcomeOf(scenario.plan)).toBe('rollback-blocked')
      expect(bundleMarker(scenario.plan.appPath)).toBe('new build')
      expect(existsSync(join(scenario.plan.appPath, 'Orca.app'))).toBe(false)
      expect(bundleMarker(scenario.plan.rollbackAppPath)).toBe('old build')
      // Five attempts at the new build, then five more at whatever occupies the slot.
      expect(readFileSync(scenario.relaunchLog, 'utf8').split('\n').filter(Boolean)).toHaveLength(
        10
      )
    },
    30_000
  )

  // Why: the slot is empty for an instant between the two renames; whatever lands there in that
  // instant must not have either bundle moved inside it.
  it('leaves both bundles where they are and relaunches whatever reoccupied the app folder', async () => {
    const scenario = createScenario({
      healthy: true,
      afterAppMovedAside: `mkdir -p "$1" && printf 'foreign' > "$1/marker"`
    })
    scenarios.push(scenario)
    scenario.appProcess.kill('SIGKILL')

    expect(await runHelper(scenario)).toBe(1)
    expect(outcomeOf(scenario.plan)).toBe('rollback-blocked')
    expect(readFileSync(join(scenario.plan.appPath, 'marker'), 'utf8')).toBe('foreign')
    expect(existsSync(join(scenario.plan.appPath, 'Orca.app'))).toBe(false)
    expect(bundleMarker(scenario.plan.rollbackAppPath)).toBe('old build')
    expect(bundleMarker(scenario.plan.stagedAppPath)).toBe('new build')
    expect(readFileSync(scenario.relaunchLog, 'utf8')).toBe(`${scenario.plan.appPath}\n`)
  }, 20_000)

  it.skipIf(process.getuid?.() === 0)(
    'reports a restore that fails into an empty slot instead of relaunching nothing',
    async () => {
      const scenario = createScenario({
        healthy: true,
        // The app's parent folder stops accepting entries once the app has been moved aside.
        afterAppMovedAside: `chmod 555 "$(dirname "$1")"`
      })
      scenarios.push(scenario)
      scenario.appProcess.kill('SIGKILL')
      const parent = join(scenario.plan.appPath, '..')
      try {
        expect(await runHelper(scenario)).toBe(1)
      } finally {
        chmodSync(parent, 0o755)
      }
      expect(outcomeOf(scenario.plan)).toBe('rollback-failed')
      expect(existsSync(scenario.plan.appPath)).toBe(false)
      expect(bundleMarker(scenario.plan.rollbackAppPath)).toBe('old build')
      expect(bundleMarker(scenario.plan.stagedAppPath)).toBe('new build')
      expect(existsSync(scenario.relaunchLog)).toBe(false)
    },
    20_000
  )

  // Why: the rollback used to be launched two seconds after SIGTERM whether or not the unhealthy
  // build had exited; one that had not still held the single-instance lock, so the launch just
  // handed off to it and the helper reported a rollback nobody was running.
  it('waits for an unhealthy build that ignores SIGTERM to be gone before relaunching the rollback', async () => {
    const scenario = createScenario({ healthy: false, newAppIgnoresSigterm: true })
    scenarios.push(scenario)
    scenario.appProcess.kill('SIGKILL')

    expect(await runHelper(scenario)).toBe(1)
    const stubborn = newAppPid(scenario)
    expect(stubborn).not.toBeNull()
    expect(isProcessAlive(stubborn!)).toBe(false)
    expect(outcomeOf(scenario.plan)).toBe('rolled-back')
    expect(bundleMarker(scenario.plan.appPath)).toBe('old build')
    expect(bundleMarker(scenario.plan.stagedAppPath)).toBe('new build')
    expect(readFileSync(scenario.relaunchLog, 'utf8')).toBe(
      `${scenario.plan.appPath}\n${scenario.plan.appPath}\n`
    )
  }, 40_000)
})
