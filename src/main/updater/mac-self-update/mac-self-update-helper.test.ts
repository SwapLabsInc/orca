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
}

/**
 * A real swap over a temp tree: the "app" is a directory with a marker file, the running
 * app process is a `sleep`, and the relaunch program is a script that logs its argument and,
 * when told to, writes the health marker a moment later like a healthy launch would.
 */
function createScenario(options: {
  healthy: boolean
  relaunch?: boolean
  staged?: boolean
}): Scenario {
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
  writeFileSync(
    relaunchProgram,
    [
      '#!/bin/sh',
      `printf '%s\\n' "$1" >> "${relaunchLog}"`,
      options.healthy ? `(sleep 1; printf 'ok\\n' > "${healthMarkerPath}") &` : '',
      'exit 0',
      ''
    ].join('\n')
  )
  chmodSync(relaunchProgram, 0o755)
  const appProcess = spawn('sleep', ['30'], { stdio: 'ignore' })
  return {
    dir,
    relaunchLog,
    appProcess,
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

function runHelper(plan: MacSelfUpdateHelperPlan): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const child = spawn(MAC_SELF_UPDATE_HELPER_SHELL, buildMacSelfUpdateHelperArgs(plan), {
      stdio: 'ignore'
    })
    child.once('error', reject)
    child.once('close', (code) => resolve(code))
  })
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

  it('spawns detached through the injected spawner and unrefs the child', () => {
    const unref = vi.fn()
    const spawner = vi.fn(() => ({ pid: 99, unref }))
    const pid = spawnMacSelfUpdateHelper(
      {
        appPid: 1,
        appPath: '/a/Orca.app',
        stagedAppPath: '/a/.Orca-update-staging/Orca.app',
        rollbackAppPath: '/a/.Orca-update-rollback/Orca.app',
        healthMarkerPath: '/s/launch-healthy',
        outcomePath: '/s/helper-outcome',
        executableRelativePath: 'Contents/MacOS/Orca',
        relaunchProgram: null,
        healthTimeoutSeconds: 90
      },
      spawner
    )
    expect(pid).toBe(99)
    expect(spawner).toHaveBeenCalledWith(MAC_SELF_UPDATE_HELPER_SHELL, expect.any(Array))
    expect(unref).toHaveBeenCalledTimes(1)
    expect(() =>
      spawnMacSelfUpdateHelper(
        {
          appPid: 1,
          appPath: '/a/Orca.app',
          stagedAppPath: '/a/s/Orca.app',
          rollbackAppPath: '/a/r/Orca.app',
          healthMarkerPath: '/s/h',
          outcomePath: '/s/o',
          executableRelativePath: 'Contents/MacOS/Orca',
          relaunchProgram: null,
          healthTimeoutSeconds: 90
        },
        () => ({ pid: undefined, unref })
      )
    ).toThrow(/did not start/)
  })
})

describePosix('helper script (real /bin/sh over a temp tree)', () => {
  const scenarios: Scenario[] = []

  afterEach(() => {
    for (const scenario of scenarios.splice(0)) {
      scenario.appProcess.kill('SIGKILL')
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
    const helper = runHelper(scenario.plan)
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

    expect(await runHelper(scenario.plan)).toBe(1)
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

    expect(await runHelper(scenario.plan)).toBe(0)
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

    expect(await runHelper(scenario.plan)).toBe(1)
    expect(outcomeOf(scenario.plan)).toBe('staged-missing')
    expect(bundleMarker(scenario.plan.appPath)).toBe('old build')
    expect(readFileSync(scenario.relaunchLog, 'utf8')).toBe(`${scenario.plan.appPath}\n`)
  }, 20_000)

  it('leaves the relaunch to the supervisor when the staged bundle is missing', async () => {
    const scenario = createScenario({ healthy: true, staged: false, relaunch: false })
    scenarios.push(scenario)
    scenario.appProcess.kill('SIGKILL')

    expect(await runHelper(scenario.plan)).toBe(1)
    expect(outcomeOf(scenario.plan)).toBe('staged-missing')
    expect(existsSync(scenario.relaunchLog)).toBe(false)
  }, 20_000)

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
        expect(await runHelper(scenario.plan)).toBe(1)
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
})
