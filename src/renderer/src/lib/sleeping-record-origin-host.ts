import {
  toRuntimeExecutionHostId,
  toSshExecutionHostId,
  type ExecutionHostId
} from '../../../shared/execution-host'
import { isWorkspaceSessionRecord } from '../../../shared/workspace-session-host-records'

/** The id spaces a sleeping record's own `connectionId` can be drawn from, so a reader can tell
 *  which one a given value came out of instead of assuming.
 *
 *  Membership proves an id's kind; absence proves nothing — `sshTargetIds` is null until loaded
 *  (store/slices/ssh.ts `sshTargetsHydrated`) and `runtimeEnvironmentIds` holds only this boot's
 *  catalogs. */
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
 * An id neither list names stays local, because catalog absence is not authoritative: local is the
 * partition every reader loads, and `adoptStrandedHostPartitionSession` can still hand it back once
 * some list names it. A guessed `ssh:<id>` has no way back.
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
