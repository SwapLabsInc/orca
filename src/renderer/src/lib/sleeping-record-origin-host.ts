import {
  toRuntimeExecutionHostId,
  toSshExecutionHostId,
  type ExecutionHostId
} from '../../../shared/execution-host'
import { isWorkspaceSessionRecord } from '../../../shared/workspace-session-host-records'

/** The id spaces a sleeping record's own `connectionId` can be drawn from, so a reader can tell
 *  which one a given value came out of instead of assuming.
 *
 *  `sshTargetIds` is null when this client has never loaded the target set: absence from an
 *  unhydrated list is no evidence the id is not a target (store/slices/ssh.ts `sshTargetsHydrated`). */
export type SleepingRecordOriginHosts = {
  runtimeEnvironmentIds: ReadonlySet<string>
  sshTargetIds: ReadonlySet<string> | null
}

/**
 * The host a sleeping record's own capture names, or null when its stamp names none.
 *
 * A NONEMPTY connectionId is not automatically an ssh target — it is the third case beside the two
 * {@link ./sleeping-record-execution-host-scope.ts} names (`undefined` unstamped, `null`
 * local-or-runtime). A paired-runtime status captured during a catalog gap carries the RUNTIME
 * environment id (runtime/web-session-tabs-sync/agent-status-patch.ts) and quit capture copies it
 * onto the record, so reading every nonempty value as ssh files the pane's only resume handle under
 * `ssh:<environmentId>` — a partition no runtime reader ever opens.
 *
 * So the kind is proven from the id spaces this client already holds, and an id neither of them
 * claims names no host rather than guessing one for it.
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
  if (origins?.sshTargetIds && !origins.sshTargetIds.has(targetId)) {
    return null
  }
  return toSshExecutionHostId(targetId)
}
