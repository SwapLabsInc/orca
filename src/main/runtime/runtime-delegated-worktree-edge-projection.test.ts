import { describe, expect, it } from 'vitest'
import { RuntimeDelegatedWorktreeEdgeProjection } from './runtime-delegated-worktree-edge-projection'

type Placement = {
  dispatch_id: string
  environment_id: string
  remote_worktree_id: string
  creator_handle: string | null
  creator_pane_key: string | null
}

function projection(args: {
  placements?: Placement[]
  worktreeByHandle?: Record<string, string>
  handleByPaneKey?: Record<string, string>
  db?: 'missing' | 'without-query'
}): RuntimeDelegatedWorktreeEdgeProjection {
  const db =
    args.db === 'missing'
      ? null
      : args.db === 'without-query'
        ? {}
        : { listDelegatedWorktreePlacements: () => args.placements ?? [] }
  return new RuntimeDelegatedWorktreeEdgeProjection({
    getDb: () => db,
    getWorktreeId: (handle) => args.worktreeByHandle?.[handle] ?? null,
    getHandleForPaneKey: (paneKey) => args.handleByPaneKey?.[paneKey] ?? null
  })
}

const placement: Placement = {
  dispatch_id: 'ctx_1',
  environment_id: 'env-1',
  remote_worktree_id: 'repo-remote::/home/ubuntu/worker',
  creator_handle: 'term_coordinator',
  creator_pane_key: 'pane-1'
}

describe('RuntimeDelegatedWorktreeEdgeProjection', () => {
  it('pairs the remote worktree with the coordinator terminal that dispatched it', () => {
    const edges = projection({
      placements: [placement],
      worktreeByHandle: { term_coordinator: 'repo-1::/home/alex/coordinator' }
    }).build()
    expect(edges).toEqual([
      {
        parentWorktreeId: 'repo-1::/home/alex/coordinator',
        childHostId: 'runtime:env-1',
        childWorktreeId: 'repo-remote::/home/ubuntu/worker',
        dispatchId: 'ctx_1'
      }
    ])
  })

  it('falls back to the pane key when the handle was reminted by a restart', () => {
    const edges = projection({
      placements: [placement],
      handleByPaneKey: { 'pane-1': 'term_reminted' },
      worktreeByHandle: { term_reminted: 'repo-1::/home/alex/coordinator' }
    }).build()
    expect(edges?.[0]?.parentWorktreeId).toBe('repo-1::/home/alex/coordinator')
  })

  it('drops a placement whose coordinator terminal is gone', () => {
    expect(projection({ placements: [placement] }).build()).toBeUndefined()
  })

  it('drops a self-referential placement', () => {
    expect(
      projection({
        placements: [placement],
        worktreeByHandle: { term_coordinator: placement.remote_worktree_id }
      }).build()
    ).toBeUndefined()
  })

  it('reports nothing rather than empty when the host cannot answer', () => {
    expect(projection({ db: 'missing' }).build()).toBeUndefined()
    expect(projection({ db: 'without-query' }).build()).toBeUndefined()
  })
})
