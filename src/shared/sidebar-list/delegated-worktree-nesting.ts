import { LOCAL_EXECUTION_HOST_ID, type ExecutionHostId } from '../execution-host'
import type { DelegatedWorktreeEdge } from '../worktree/delegated-worktree-edge'
import {
  composeWorktreeHostIdentity,
  getWorktreeHostIdentity
} from '../worktree/host-qualified-identity'
import type { WorktreeLineage } from '../worktree/lineage-types'
import type { Worktree } from '../worktree/types'
import { getSidebarLineageRowsByIdentity } from './pinned-section-worktrees'
import { getSidebarLineageParentsByIdentity } from './worktree-lineage-projection'

/**
 * Which delegated edges the sidebar may actually draw: child identity → parent
 * identity, host-qualified on both ends (STA-4343).
 *
 * Git lineage wins wherever it exists: an edge is only a fallback for a card
 * whose real parent cannot be recorded because it sits on another host.
 */
export function resolveDelegatedWorktreeNesting(args: {
  worktrees: readonly Worktree[]
  edges: readonly DelegatedWorktreeEdge[]
  /** Host the runtime that published the edges stamps its own worktrees with. Not the
   *  focused host: focus is a filter over every host's rows, not a claim about the publisher. */
  homeHostId: ExecutionHostId
  /** Parent identity already proven by git lineage, when the row has one. */
  getLineageParentIdentity: (worktree: Worktree) => string | undefined
}): Map<string, string> {
  const { worktrees, edges, homeHostId, getLineageParentIdentity } = args
  const parentIdentityByChildIdentity = new Map<string, string>()
  if (edges.length === 0) {
    return parentIdentityByChildIdentity
  }
  const byIdentity = new Map<string, Worktree>(
    worktrees.map((worktree) => [getWorktreeHostIdentity(worktree), worktree])
  )
  for (const edge of edges) {
    const childIdentity = composeWorktreeHostIdentity(edge.childHostId, edge.childWorktreeId)
    if (parentIdentityByChildIdentity.has(childIdentity)) {
      continue
    }
    const child = byIdentity.get(childIdentity)
    if (!child || getLineageParentIdentity(child)) {
      continue
    }
    // The coordinator's worktree belongs to the runtime that published the edge.
    // An unqualified row cannot be proven to be that one, so it is not a parent.
    const parentIdentity = composeWorktreeHostIdentity(homeHostId, edge.parentWorktreeId)
    if (!byIdentity.has(parentIdentity) || parentIdentity === childIdentity) {
      continue
    }
    if (
      reachesDescendant({
        fromIdentity: parentIdentity,
        targetIdentity: childIdentity,
        byIdentity,
        parentIdentityByChildIdentity,
        getLineageParentIdentity
      })
    ) {
      continue
    }
    parentIdentityByChildIdentity.set(childIdentity, parentIdentity)
  }
  return parentIdentityByChildIdentity
}

/** Walks git lineage and delegated edges together: a cycle through both still hangs the emitter. */
function reachesDescendant(args: {
  fromIdentity: string
  targetIdentity: string
  byIdentity: ReadonlyMap<string, Worktree>
  parentIdentityByChildIdentity: ReadonlyMap<string, string>
  getLineageParentIdentity: (worktree: Worktree) => string | undefined
}): boolean {
  const { fromIdentity, targetIdentity, byIdentity, parentIdentityByChildIdentity } = args
  const visited = new Set<string>()
  let cursor: string | undefined = fromIdentity
  while (cursor && !visited.has(cursor)) {
    if (cursor === targetIdentity) {
      return true
    }
    visited.add(cursor)
    const worktree = byIdentity.get(cursor)
    cursor =
      parentIdentityByChildIdentity.get(cursor) ??
      (worktree ? args.getLineageParentIdentity(worktree) : undefined)
  }
  return false
}

/**
 * Lineage children plus each delegated worker under its coordinator. Joining the occurrence
 * plan's one nesting input places, pins, reveals and folds the worker like a lineage child;
 * nothing is written as lineage, so removal and every other lineage rule stay host-local.
 */
export function withDelegatedWorktreeChildren(
  lineageChildren: Map<string, Worktree[]>,
  inputs: {
    /** The visible rows: an edge whose coordinator or worker is filtered out is not drawn. */
    worktrees: readonly Worktree[]
    lineageById: Readonly<Record<string, WorktreeLineage>>
    worktreeMap: ReadonlyMap<string, Worktree>
    delegatedWorktreeEdges?: readonly DelegatedWorktreeEdge[]
  }
): Map<string, Worktree[]> {
  const edges = inputs.delegatedWorktreeEdges ?? []
  if (edges.length === 0) {
    return lineageChildren
  }
  // Unfiltered: a lineage parent hidden by the repo filter still outranks a delegated edge.
  const lineageParentByIdentity = getSidebarLineageParentsByIdentity(
    inputs.lineageById,
    getSidebarLineageRowsByIdentity(inputs.worktrees, inputs.worktreeMap)
  )
  const nesting = resolveDelegatedWorktreeNesting({
    worktrees: inputs.worktrees,
    edges,
    // Not defaultHostId: the edges arrive on this window's own graph sync, so their
    // coordinator is always a local row, while the focused host follows the host filter.
    homeHostId: LOCAL_EXECUTION_HOST_ID,
    getLineageParentIdentity: (worktree) => {
      const parent = lineageParentByIdentity.get(getWorktreeHostIdentity(worktree))
      return parent ? getWorktreeHostIdentity(parent) : undefined
    }
  })
  if (nesting.size === 0) {
    return lineageChildren
  }
  const byIdentity = new Map<string, Worktree>(
    inputs.worktrees.map((worktree) => [getWorktreeHostIdentity(worktree), worktree])
  )
  const merged = new Map(lineageChildren)
  for (const [childIdentity, parentIdentity] of nesting) {
    const child = byIdentity.get(childIdentity)
    if (child) {
      merged.set(parentIdentity, [...(merged.get(parentIdentity) ?? []), child])
    }
  }
  return merged
}
