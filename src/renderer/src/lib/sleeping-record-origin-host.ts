import {
  toRuntimeExecutionHostId,
  toSshExecutionHostId,
  type ExecutionHostId
} from '../../../shared/execution-host'
import { isWorkspaceSessionRecord } from '../../../shared/workspace-session-host-records'

/** The id spaces a sleeping record's own `connectionId` can be drawn from, so a reader can tell
 *  which one a given value came out of instead of assuming.
 *
 *  Neither set is a complete census: `sshTargetIds` is null until this client loads the target set
 *  (store/slices/ssh.ts `sshTargetsHydrated`), and `runtimeEnvironmentIds` is a best-effort union of
 *  the catalogs this boot happens to hold. So membership proves an id's kind; absence proves
 *  nothing about it. */
export type SleepingRecordOriginHosts = {
  runtimeEnvironmentIds: ReadonlySet<string>
  sshTargetIds: ReadonlySet<string> | null
}

/**
 * The host a sleeping record's own capture names, or null when this client cannot prove one.
 *
 * A NONEMPTY connectionId is not automatically an ssh target — it is the third case beside the two
 * {@link ./sleeping-record-execution-host-scope.ts} names (`undefined` unstamped, `null`
 * local-or-runtime). A paired-runtime status captured during a catalog gap carries the RUNTIME
 * environment id (runtime/web-session-tabs-sync/agent-status-patch.ts) and quit capture copies it
 * onto the record, so reading every nonempty value as ssh files the pane's only resume handle under
 * `ssh:<environmentId>` — a partition no runtime reader ever opens.
 *
 * Only positive membership answers, because neither id space can disprove an id: an unhydrated ssh
 * list has not loaded, and the runtime union is whatever catalogs this boot holds, so an id both
 * lists are silent about is indistinguishable between a catalog gap, a removed environment and an
 * unknown target. Null is that "cannot prove", and it leaves the row local — the partition every
 * reader loads, and the one `adoptStrandedHostPartitionSession` returns to its owner once some list
 * can name it. A guessed `ssh:<id>` has no such way back.
 */
export function sleepingRecordOriginHostId(
  entry: unknown,
  origins: SleepingRecordOriginHosts | undefined
): ExecutionHostId | null {
  if (!isWorkspaceSessionRecord(entry) || typeof entry.connectionId !== 'string') {
    return null
  }
  const targetId = entry.connectionId.trim()
  if (!targetId) {
    return null
  }
  if (origins?.runtimeEnvironmentIds.has(targetId)) {
    return toRuntimeExecutionHostId(targetId)
  }
  if (origins?.sshTargetIds?.has(targetId)) {
    return toSshExecutionHostId(targetId)
  }
  return null
}
