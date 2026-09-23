import type { ExecutionHostId } from '../../../../../../shared/execution-host'
import type { DelegatedWorktreeEdge } from '../../../../../../shared/worktree/delegated-worktree-edge'
import type { Worktree } from '../../../../../../shared/worktree/types'
import {
  composeWorktreeHostIdentity,
  getWorktreeHostIdentity
} from '../../../../../../shared/worktree/host-qualified-identity'

export type DelegatedWorktreeNesting = {
  /** Child identity → parent identity, host-qualified on both ends (STA-4343). */
  parentIdentityByChildIdentity: ReadonlyMap<string, string>
  /** Child identity → the worktree whose section the child is rendered in. */
  sectionAnchorByChildIdentity: ReadonlyMap<string, Worktree>
}

const EMPTY_NESTING: DelegatedWorktreeNesting = {
  parentIdentityByChildIdentity: new Map(),
  sectionAnchorByChildIdentity: new Map()
}

/**
 * Which delegated edges the sidebar may actually draw.
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
}): DelegatedWorktreeNesting {
  const { worktrees, edges, homeHostId, getLineageParentIdentity } = args
  if (edges.length === 0) {
    return EMPTY_NESTING
  }
  const byIdentity = new Map(
    worktrees.map((worktree) => [getWorktreeHostIdentity(worktree), worktree])
  )
  const parentIdentityByChildIdentity = new Map<string, string>()
  const sectionAnchorByChildIdentity = new Map<string, Worktree>()
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
    const parent = byIdentity.get(parentIdentity)
    if (!parent || parentIdentity === childIdentity) {
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
    sectionAnchorByChildIdentity.set(childIdentity, parent)
  }
  return { parentIdentityByChildIdentity, sectionAnchorByChildIdentity }
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
