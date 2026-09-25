import { spawnProcess } from '../../../shared/child-process/run-process'
import { MacSelfUpdateError } from './mac-self-update-failure'

/** How long the helper waits for the relaunched app's health marker before rolling back. */
export const MAC_SELF_UPDATE_HEALTH_TIMEOUT_SECONDS = 90

export const MAC_SELF_UPDATE_HELPER_ARGV0 = 'orca-mac-self-update'
export const MAC_SELF_UPDATE_HELPER_SHELL = '/bin/sh'
export const MAC_SELF_UPDATE_RELAUNCH_PROGRAM = '/usr/bin/open'

/** What the helper writes to its outcome file; the next launch turns it into a diagnostic. */
export type MacSelfUpdateHelperOutcome =
  | 'healthy'
  | 'swapped'
  | 'rolled-back'
  | 'relaunch-failed'
  | 'rename-staged-failed'
  | 'rename-current-failed'
  | 'rollback-dir-failed'
  | 'staged-missing'
  | 'app-still-running'

/**
 * The swap runs after this process has exited, so it cannot be JavaScript. It is a fixed
 * POSIX sh program handed to `/bin/sh -c`: every path and number arrives as a positional
 * argument, nothing is interpolated into it, and it calls no interpreter but `mv`, `ps`,
 * `kill` and the relaunch program it was given. Steps, per plan §13.2:
 *
 * 1. wait for the app process to exit (bounded; the exit watchdog guarantees it);
 * 2. move the current bundle aside as the rollback;
 * 3. move the staged, verified bundle into place;
 * 4. relaunch (unless a serve supervisor owns the relaunch);
 * 5. wait for the new app's health marker; without one, restore the rollback and relaunch it.
 */
export const MAC_SELF_UPDATE_HELPER_SCRIPT = `set -u
pid=$1
app=$2
staged=$3
rollback=$4
marker=$5
relaunch=$6
timeout=$7
outcome=$8
exe=$9
report() {
  printf '%s\\n' "$1" > "$outcome.tmp" 2>/dev/null && mv -f "$outcome.tmp" "$outcome" 2>/dev/null
}
launch() {
  n=0
  while [ "$n" -lt 5 ]; do
    if "$relaunch" "$1"; then
      return 0
    fi
    n=$((n + 1))
    sleep 1
  done
  return 1
}
stop_new_app() {
  ps -axo pid=,args= | while read -r p a; do
    case "$a" in
      "$app/$exe"|"$app/$exe -psn"*) kill "$p" 2>/dev/null ;;
    esac
  done
}
n=0
while kill -0 "$pid" 2>/dev/null; do
  n=$((n + 1))
  if [ "$n" -gt 1800 ]; then
    report app-still-running
    exit 1
  fi
  sleep 0.1
done
if [ ! -d "$staged" ]; then
  report staged-missing
  exit 1
fi
rm -rf "$rollback"
if ! mkdir -p "$(dirname "$rollback")"; then
  report rollback-dir-failed
  exit 1
fi
if ! mv "$app" "$rollback"; then
  report rename-current-failed
  exit 1
fi
if ! mv "$staged" "$app"; then
  mv "$rollback" "$app"
  report rename-staged-failed
  exit 1
fi
rm -f "$marker"
if [ -z "$relaunch" ]; then
  report swapped
  exit 0
fi
if ! launch "$app"; then
  mv "$app" "$staged"
  mv "$rollback" "$app"
  launch "$app"
  report relaunch-failed
  exit 1
fi
n=0
while [ ! -e "$marker" ]; do
  n=$((n + 1))
  if [ "$n" -gt "$timeout" ]; then
    stop_new_app
    sleep 2
    mv "$app" "$staged"
    mv "$rollback" "$app"
    launch "$app"
    report rolled-back
    exit 1
  fi
  sleep 1
done
report healthy
exit 0
`

export type MacSelfUpdateHelperPlan = {
  appPid: number
  appPath: string
  stagedAppPath: string
  rollbackAppPath: string
  healthMarkerPath: string
  outcomePath: string
  /** `Contents/MacOS/<executable>` inside the bundle, so a hung new app can be found by its command line. */
  executableRelativePath: string
  /** Null when a serve supervisor relaunches; the helper then only swaps. */
  relaunchProgram: string | null
  healthTimeoutSeconds: number
}

/** The exact `/bin/sh` argv: the static script, then every path as its own argument. */
export function buildMacSelfUpdateHelperArgs(plan: MacSelfUpdateHelperPlan): string[] {
  return [
    '-c',
    MAC_SELF_UPDATE_HELPER_SCRIPT,
    MAC_SELF_UPDATE_HELPER_ARGV0,
    String(plan.appPid),
    plan.appPath,
    plan.stagedAppPath,
    plan.rollbackAppPath,
    plan.healthMarkerPath,
    plan.relaunchProgram ?? '',
    String(plan.healthTimeoutSeconds),
    plan.outcomePath,
    plan.executableRelativePath
  ]
}

export type HelperSpawner = (program: string, args: string[]) => { pid?: number; unref(): void }

const defaultSpawner: HelperSpawner = (program, args) =>
  spawnProcess({ program, args, detached: true, stdio: 'ignore', timeoutMs: null })

/** Starts the helper in its own session so it outlives this process and its quit. */
export function spawnMacSelfUpdateHelper(
  plan: MacSelfUpdateHelperPlan,
  spawner: HelperSpawner = defaultSpawner
): number {
  let child: ReturnType<HelperSpawner>
  try {
    child = spawner(MAC_SELF_UPDATE_HELPER_SHELL, buildMacSelfUpdateHelperArgs(plan))
  } catch (error) {
    throw new MacSelfUpdateError(
      'helper-launch-failed',
      `Could not start the update helper: ${error instanceof Error ? error.message : String(error)}`
    )
  }
  if (!child.pid) {
    throw new MacSelfUpdateError('helper-launch-failed', 'The update helper did not start.')
  }
  child.unref()
  return child.pid
}
