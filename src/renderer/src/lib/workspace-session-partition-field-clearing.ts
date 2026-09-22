import type {
  WorkspaceSessionPatch,
  WorkspaceSessionState
} from '../../../shared/workspace-session-state-types'
import type { ExecutionHostId } from '../../../shared/execution-host'
import {
  nonLocalHostSessionEntries,
  seedEmptyPartitionField,
  type HostSessionSlices
} from './workspace-session-host-split'

/** Fields whose last row leaving a non-local partition must still reach that partition. Main
 *  applies a partition patch field by field, so a host the split routes no rows to keeps its stale
 *  copy, and the next boot's merge resurrects it. */
const CLEARED_PARTITION_FIELDS = [
  'sleepingAgentSessionsByPaneKey'
] as const satisfies readonly (keyof WorkspaceSessionState)[]

type ClearedPartitionField = (typeof CLEARED_PARTITION_FIELDS)[number]

/** Per field, each non-local host this writer last sent rows to, tagged with the write that did. */
type HostsHoldingRows = Map<ClearedPartitionField, Map<ExecutionHostId, object>>

const hostsHoldingRowsByWriter = new WeakMap<object, HostsHoldingRows>()

function trackedFieldsFor(writer: object): HostsHoldingRows {
  let tracked = hostsHoldingRowsByWriter.get(writer)
  if (!tracked) {
    tracked = new Map()
    hostsHoldingRowsByWriter.set(writer, tracked)
  }
  return tracked
}

function hostsFor(
  tracked: HostsHoldingRows,
  field: ClearedPartitionField
): Map<ExecutionHostId, object> {
  let hosts = tracked.get(field)
  if (!hosts) {
    hosts = new Map()
    tracked.set(field, hosts)
  }
  return hosts
}

/** Seed ownership from the partitions a read found rows in. Learning only from this renderer's own
 *  patches left nothing to clear for a record restored from disk and retired before the first
 *  patch carrying the field — the empty-map patch then updated 'local' alone and the stale remote
 *  row merged back on the next boot. */
export function trackPartitionFieldsHeldByRead(writer: object, slices: HostSessionSlices): void {
  const tracked = trackedFieldsFor(writer)
  const readToken = {}
  for (const field of CLEARED_PARTITION_FIELDS) {
    for (const [hostId, slice] of nonLocalHostSessionEntries(slices)) {
      const rows = slice[field]
      if (rows && Object.keys(rows).length > 0) {
        hostsFor(tracked, field).set(hostId, readToken)
      }
    }
  }
}

/** Full-snapshot counterpart of `nonLocalPartitionPatches`: `api.set` replaces a partition, so a
 *  host the snapshot routes rows to is cleared by the write itself — but a host it omits entirely
 *  keeps its stale rows. Mutates `slices` before the shadow attach so parked rows still ride along.
 *
 *  The host stays tracked: the synchronous quit path has no completion signal, and a redundant
 *  empty field costs nothing. */
export function clearSnapshotPartitionFields(
  writer: object,
  payload: WorkspaceSessionState,
  slices: HostSessionSlices
): void {
  const tracked = hostsHoldingRowsByWriter.get(writer)
  if (!tracked) {
    return
  }
  for (const field of CLEARED_PARTITION_FIELDS) {
    if (!Object.hasOwn(payload, field)) {
      continue
    }
    for (const hostId of tracked.get(field)?.keys() ?? []) {
      if (slices[hostId]?.[field] !== undefined) {
        continue
      }
      seedEmptyPartitionField(slices, hostId, payload, field)
    }
  }
}

export type PartitionPatch = {
  hostId: ExecutionHostId
  patch: WorkspaceSessionPatch
  /** Retires the clears this patch carries; call only once the partition write resolved. */
  onPersisted: () => void
}

/** The non-local partition patches for one debounced write, including an empty field for every
 *  host an earlier write left rows on. Only hosts this writer itself filled are cleared: a
 *  partition it never wrote may hold rows main owns, and leak is the safe direction. */
export function nonLocalPartitionPatches(
  writer: object,
  patch: WorkspaceSessionPatch,
  slices: HostSessionSlices
): PartitionPatch[] {
  const tracked = trackedFieldsFor(writer)
  const writeToken = {}
  const patches = new Map<ExecutionHostId, WorkspaceSessionPatch>(
    nonLocalHostSessionEntries(slices).map(([hostId, slice]) => [hostId, slice])
  )
  const clearedByHost = new Map<ExecutionHostId, ClearedPartitionField[]>()
  for (const field of CLEARED_PARTITION_FIELDS) {
    if (!Object.hasOwn(patch, field)) {
      continue
    }
    const hosts = hostsFor(tracked, field)
    for (const [hostId, hostPatch] of patches) {
      if (hostPatch[field] !== undefined) {
        hosts.set(hostId, writeToken)
      }
    }
    for (const hostId of hosts.keys()) {
      const hostPatch = patches.get(hostId)
      if (hostPatch?.[field] !== undefined) {
        continue
      }
      patches.set(hostId, { ...hostPatch, [field]: {} })
      // Re-tagged so an older clear settling late cannot retire a host a newer write refilled.
      hosts.set(hostId, writeToken)
      clearedByHost.set(hostId, [...(clearedByHost.get(hostId) ?? []), field])
    }
  }
  return [...patches].map(([hostId, hostPatch]) => ({
    hostId,
    patch: hostPatch,
    onPersisted: () => {
      for (const field of clearedByHost.get(hostId) ?? []) {
        const hosts = tracked.get(field)
        // A failed clear stays tracked, so the next write carrying the field retries it.
        if (hosts?.get(hostId) === writeToken) {
          hosts.delete(hostId)
        }
      }
    }
  }))
}
