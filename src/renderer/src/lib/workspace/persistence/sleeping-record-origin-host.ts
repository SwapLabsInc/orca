import {
  getRepoExecutionHostId,
  parseExecutionHostId,
  toRuntimeExecutionHostId,
  toSshExecutionHostId,
  type ExecutionHostId
} from '../../../../../shared/execution-host/execution-host'
import type { HostPersistenceState } from './workspace-session-host-persistence'
import { isWorkspaceSessionRecord } from '../../../../../shared/workspace-session/workspace-session-host-records'

/** Catalog fields the origin id spaces are read from, carried on the persistence state. */
export type OriginCatalogState = {
  /** Paired runtime environments this client knows. A sleeping record stamped with one of these ids
   *  is a runtime capture, not an ssh target — see `sleepingRecordOriginHostId`. */
  runtimeEnvironments?: readonly { id: string }[]
  /** Configured ssh targets, keyed by target id. Only meaningful once `sshTargetsHydrated`. */
  sshTargetLabels?: ReadonlyMap<string, string>
  sshTargetsHydrated?: boolean
}

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

/** What a session routing carries so a write can route a sleeping record by its own capture. */
export type OriginRouting = { sleepingRecordOrigins: SleepingRecordOriginHosts }

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

/** Every runtime environment id this client can name, read through the host ids the catalogs
 *  already carry rather than a second parser for the same value. Used only to tell a runtime stamp
 *  on a sleeping record apart from an ssh target id. */
function collectRuntimeEnvironmentIds(
  state: HostPersistenceState,
  runtimeHostIdByWorktreeId: ReadonlyMap<string, ExecutionHostId | null>
): Set<string> {
  const environmentIds = new Set<string>()
  const addHost = (hostId: string | null | undefined): void => {
    const parsed = parseExecutionHostId(hostId)
    if (parsed?.kind === 'runtime') {
      environmentIds.add(parsed.environmentId)
    }
  }
  for (const environment of state.runtimeEnvironments ?? []) {
    const id = environment.id.trim()
    if (id) {
      environmentIds.add(id)
    }
  }
  for (const hostId of runtimeHostIdByWorktreeId.values()) {
    addHost(hostId)
  }
  for (const hostId of Object.values(state.restoredRuntimeHostIdByWorkspaceSessionKey ?? {})) {
    addHost(hostId)
  }
  for (const hostId of Object.values(state.contestedPrimaryHostBySessionKey ?? {})) {
    addHost(hostId)
  }
  for (const workspace of state.folderWorkspaces ?? []) {
    addHost(workspace.executionHostId)
  }
  for (const group of state.projectGroups ?? []) {
    addHost(group.executionHostId)
  }
  for (const repo of state.repos) {
    addHost(getRepoExecutionHostId(repo))
  }
  return environmentIds
}

/** The id spaces this client's catalogs name, for routing a sleeping record by its own capture. */
export function buildSleepingRecordOriginHosts(
  state: HostPersistenceState,
  runtimeHostIdByWorktreeId: ReadonlyMap<string, ExecutionHostId | null>
): SleepingRecordOriginHosts {
  return {
    runtimeEnvironmentIds: collectRuntimeEnvironmentIds(state, runtimeHostIdByWorktreeId),
    // Why the hydration gate: an unloaded target list says nothing about an id, so `null` keeps it
    // distinguishable from a loaded list that genuinely does not hold the id.
    sshTargetIds: state.sshTargetsHydrated ? new Set(state.sshTargetLabels?.keys() ?? []) : null
  }
}

/** `routing` plus the origin id spaces; keeps the routing builder within its line budget. */
export function withOriginHosts<Routing extends object>(
  routing: Routing,
  state: HostPersistenceState,
  runtimeHostIdByWorktreeId: ReadonlyMap<string, ExecutionHostId | null>
): Routing & OriginRouting {
  return {
    ...routing,
    sleepingRecordOrigins: buildSleepingRecordOriginHosts(state, runtimeHostIdByWorktreeId)
  }
}
