import { toRuntimeExecutionHostId } from '../../shared/execution-host'
import type { DelegatedWorktreeEdge } from '../../shared/worktree/delegated-worktree-edge'
import type { DelegatedWorktreePlacementRow } from './orchestration/db/federation/federated-dispatch-store'

/** Enough for any realistic sidebar; the renderer drops edges whose rows it cannot see anyway. */
const MAX_DELEGATED_EDGES = 500

/** Only the placement query, so a test — and an older db without it — needs no stand-in for the rest. */
type DelegatedWorktreePlacementSource = {
  listDelegatedWorktreePlacements?: (limit: number) => DelegatedWorktreePlacementRow[]
}

type DelegatedWorktreeEdgeDependencies = {
  getDb(): DelegatedWorktreePlacementSource | null
  /** Worktree the coordinator terminal runs in, by handle. */
  getWorktreeId(handle: string): string | null
  /** Handles are minted per process; after a restart only the pane identity still names the terminal. */
  getHandleForPaneKey(paneKey: string): string | null
}

/**
 * The coordinator side of a cross-host delegation, for the sidebar.
 *
 * Only this runtime can build it: the worker host knows nothing about the
 * coordinator's workspace, and the edge would fail the same-repository,
 * same-host rule that git lineage enforces there.
 */
export class RuntimeDelegatedWorktreeEdgeProjection {
  constructor(private readonly deps: DelegatedWorktreeEdgeDependencies) {}

  build(): DelegatedWorktreeEdge[] | undefined {
    const db = this.deps.getDb()
    if (!db?.listDelegatedWorktreePlacements) {
      return undefined
    }
    const edges: DelegatedWorktreeEdge[] = []
    for (const placement of db.listDelegatedWorktreePlacements(MAX_DELEGATED_EDGES)) {
      const parentWorktreeId = this.resolveCoordinatorWorktreeId(placement)
      if (!parentWorktreeId || parentWorktreeId === placement.remote_worktree_id) {
        continue
      }
      edges.push({
        parentWorktreeId,
        childHostId: toRuntimeExecutionHostId(placement.environment_id),
        childWorktreeId: placement.remote_worktree_id,
        dispatchId: placement.dispatch_id
      })
    }
    return edges.length > 0 ? edges : undefined
  }

  private resolveCoordinatorWorktreeId(placement: {
    creator_handle: string | null
    creator_pane_key: string | null
  }): string | null {
    const byHandle = placement.creator_handle
      ? this.deps.getWorktreeId(placement.creator_handle)
      : null
    if (byHandle) {
      return byHandle
    }
    const handle = placement.creator_pane_key
      ? this.deps.getHandleForPaneKey(placement.creator_pane_key)
      : null
    return handle ? this.deps.getWorktreeId(handle) : null
  }
}
