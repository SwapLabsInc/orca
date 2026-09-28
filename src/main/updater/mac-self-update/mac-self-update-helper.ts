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
  | 'rollback-blocked'
  | 'rollback-failed'
  | 'staged-missing'
  | 'app-still-running'
  | 'new-app-still-running'

/**
 * The swap runs after this process has exited, so it cannot be JavaScript. It is a fixed
 * POSIX sh program handed to `/bin/sh -c`: every path and number arrives as a positional
 * argument, nothing is interpolated into it, and it calls no interpreter but `mv`, `ps`,
 * `kill` and the relaunch program it was given. Steps, per plan §13.2:
 *
 * 1. wait for the app process to exit (bounded; the exit watchdog guarantees it);
 * 2. move the current bundle aside as the rollback, once the previous rollback is gone (`mv`
 *    onto a surviving directory would nest the bundle inside it);
 * 3. move the staged, verified bundle into place;
 * 4. relaunch (unless a serve supervisor owns the relaunch);
 * 5. wait for the new app's health marker; without one, stop the new app and wait for it to be
 *    gone (it holds the single-instance lock), then restore the rollback and relaunch it. A new
 *    app that outlives SIGKILL leaves both bundles where they are and nothing is relaunched.
 *
 * The app has already quit by step 2, so every failure that leaves or restores the previous
 * bundle relaunches it too (when the helper owns relaunching): a failed update must never
 * leave Orca closed with a runnable app still on disk. Every `mv` of a bundle is guarded the
 * same way: `mv` onto a directory that still exists moves the bundle *inside* it, so a restore
 * only runs into an empty slot and otherwise relaunches whatever occupies it.
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
new_app_pids() {
  ps -axo pid=,args= | while read -r p a; do
    case "$a" in
      "$app/$exe"|"$app/$exe -psn"*) printf '%s ' "$p" ;;
    esac
  done
}
stop_new_app() {
  for sig in TERM KILL; do
    pids=$(new_app_pids)
    if [ -z "$pids" ]; then
      return 0
    fi
    kill -s "$sig" $pids 2>/dev/null
    n=0
    while [ "$n" -lt 100 ] && [ -n "$(new_app_pids)" ]; do
      n=$((n + 1))
      sleep 0.1
    done
  done
  [ -z "$(new_app_pids)" ]
}
give_up() {
  report "$1"
  if [ -n "$relaunch" ]; then
    launch "$app"
  fi
  exit 1
}
restore_previous() {
  if [ -e "$app" ]; then
    give_up rollback-blocked
  fi
  if ! mv "$rollback" "$app"; then
    report rollback-failed
    exit 1
  fi
}
roll_back() {
  if ! stop_new_app; then
    report new-app-still-running
    exit 1
  fi
  mkdir -p "$(dirname "$staged")"
  mv "$app" "$staged"
  restore_previous
  report "$1"
  launch "$app"
  exit 1
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
  give_up staged-missing
fi
if ! rm -rf "$rollback" || [ -e "$rollback" ]; then
  give_up rollback-dir-failed
fi
if ! mkdir -p "$(dirname "$rollback")"; then
  give_up rollback-dir-failed
fi
if ! mv "$app" "$rollback"; then
  give_up rename-current-failed
fi
if [ -e "$app" ] || ! mv "$staged" "$app"; then
  restore_previous
  give_up rename-staged-failed
fi
rm -f "$marker"
if [ -z "$relaunch" ]; then
  report swapped
  exit 0
fi
if ! launch "$app"; then
  roll_back relaunch-failed
fi
n=0
while [ ! -e "$marker" ]; do
  n=$((n + 1))
  if [ "$n" -gt "$timeout" ]; then
    roll_back rolled-back
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

export type HelperSpawner = (
  program: string,
  args: string[]
) => {
  pid?: number
  unref(): void
  on(event: 'error', listener: (error: Error) => void): unknown
}

const defaultSpawner: HelperSpawner = (program, args) =>
  spawnProcess({ program, args, detached: true, stdio: 'ignore', timeoutMs: null })

/**
 * Starts the helper in its own session so it outlives this process and its quit.
 * `onSpawnError` hears the cause of a refused spawn, which arrives after this has thrown.
 */
export function spawnMacSelfUpdateHelper(
  plan: MacSelfUpdateHelperPlan,
  spawner: HelperSpawner = defaultSpawner,
  onSpawnError: (error: Error) => void = () => undefined
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
  // Why: a refused spawn (EAGAIN, EMFILE, EACCES) emits `error` a tick later; unheard, it takes the app down.
  child.on('error', onSpawnError)
  if (!child.pid) {
    throw new MacSelfUpdateError('helper-launch-failed', 'The update helper did not start.')
  }
  child.unref()
  return child.pid
}
