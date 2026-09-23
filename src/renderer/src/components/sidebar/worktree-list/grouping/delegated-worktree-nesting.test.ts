import { describe, expect, it } from 'vitest'
import { buildRows } from './build-rows'
import { resolveDelegatedWorktreeNesting } from './delegated-worktree-nesting'
import { repo, remoteRepo, worktree } from '../../worktree-list-groups-test-fixtures'
import type { DelegatedWorktreeEdge } from '../../../../../../shared/worktree/delegated-worktree-edge'
import type { WorktreeLineage } from '../../../../../../shared/worktree/lineage-types'
import type { Worktree } from '../../../../../../shared/worktree/types'
import type { Row } from './row-types'

const REMOTE_HOST = 'runtime:env-1' as const

const coordinator: Worktree = {
  ...worktree,
  id: 'repo-1::/home/alex/orca/coordinator',
  hostId: 'local',
  instanceId: 'coordinator-instance',
  displayName: 'coordinator'
}

const remoteWorker: Worktree = {
  ...worktree,
  id: 'repo-remote::/home/ubuntu/orca/worker',
  repoId: remoteRepo.id,
  hostId: REMOTE_HOST,
  instanceId: 'worker-instance',
  displayName: 'worker'
}

const edge: DelegatedWorktreeEdge = {
  parentWorktreeId: coordinator.id,
  childHostId: REMOTE_HOST,
  childWorktreeId: remoteWorker.id,
  dispatchId: 'ctx_1'
}

function nest(args: {
  worktrees: readonly Worktree[]
  edges: readonly DelegatedWorktreeEdge[]
  lineageParentIdentity?: (worktree: Worktree) => string | undefined
}): ReadonlyMap<string, string> {
  return resolveDelegatedWorktreeNesting({
    worktrees: args.worktrees,
    edges: args.edges,
    homeHostId: 'local',
    getLineageParentIdentity: args.lineageParentIdentity ?? (() => undefined)
  }).parentIdentityByChildIdentity
}

describe('resolveDelegatedWorktreeNesting', () => {
  it('nests a remote worker under the coordinator that dispatched it', () => {
    expect(nest({ worktrees: [coordinator, remoteWorker], edges: [edge] })).toEqual(
      new Map([[`${REMOTE_HOST}|${remoteWorker.id}`, `local|${coordinator.id}`]])
    )
  })

  it('ignores an edge whose coordinator row is not on this machine', () => {
    const elsewhere = { ...coordinator, hostId: 'runtime:env-2' as const }
    expect(nest({ worktrees: [elsewhere, remoteWorker], edges: [edge] }).size).toBe(0)
  })

  it('leaves git lineage in charge when the child already has a parent', () => {
    expect(
      nest({
        worktrees: [coordinator, remoteWorker],
        edges: [edge],
        lineageParentIdentity: (candidate) =>
          candidate.id === remoteWorker.id ? `${REMOTE_HOST}|repo-remote::/other` : undefined
      }).size
    ).toBe(0)
  })

  it('refuses an edge that would close a cycle', () => {
    const backEdge: DelegatedWorktreeEdge = {
      parentWorktreeId: coordinator.id,
      childHostId: REMOTE_HOST,
      childWorktreeId: remoteWorker.id,
      dispatchId: 'ctx_2'
    }
    const resolved = resolveDelegatedWorktreeNesting({
      worktrees: [coordinator, remoteWorker],
      edges: [backEdge],
      homeHostId: REMOTE_HOST,
      // The coordinator is itself a delegated child of the worker in this shape.
      getLineageParentIdentity: (candidate) =>
        candidate.id === coordinator.id ? `${REMOTE_HOST}|${remoteWorker.id}` : undefined
    })
    expect(resolved.parentIdentityByChildIdentity.size).toBe(0)
  })

  it('keeps the first edge when a worktree was reused by a later dispatch', () => {
    const reused: DelegatedWorktreeEdge = {
      ...edge,
      parentWorktreeId: 'repo-1::/other',
      dispatchId: 'ctx_3'
    }
    expect(nest({ worktrees: [coordinator, remoteWorker], edges: [edge, reused] })).toEqual(
      new Map([[`${REMOTE_HOST}|${remoteWorker.id}`, `local|${coordinator.id}`]])
    )
  })
})

function findItem(
  rows: readonly Row[],
  worktreeId: string
): Extract<Row, { type: 'item' }> | undefined {
  return rows.find(
    (row): row is Extract<Row, { type: 'item' }> =>
      row.type === 'item' && row.worktree.id === worktreeId
  )
}

describe('buildRows with delegated edges', () => {
  const repoMapWithRemote = new Map([
    [repo.id, repo],
    [remoteRepo.id, remoteRepo]
  ])
  const lineage: Record<string, WorktreeLineage> = {}

  function rowsFor(edges: readonly DelegatedWorktreeEdge[]) {
    return buildRows(
      'repo',
      [coordinator, remoteWorker],
      repoMapWithRemote,
      null,
      new Set(),
      undefined,
      undefined,
      'manual',
      lineage,
      new Map([
        [coordinator.id, coordinator],
        [remoteWorker.id, remoteWorker]
      ]),
      true,
      undefined,
      [],
      new Set(),
      new Map(),
      new Map(),
      [],
      undefined,
      [],
      undefined,
      'local',
      'single-location',
      edges
    )
  }

  it('renders the remote worker nested inside the coordinator repo section', () => {
    const rows = rowsFor([edge])
    const worker = findItem(rows, remoteWorker.id)
    const parent = findItem(rows, coordinator.id)
    expect(worker).toMatchObject({ depth: 1, sectionKey: parent?.sectionKey })
    expect(parent).toMatchObject({ depth: 0, lineageChildCount: 1 })
    expect(
      rows.filter((row) => row.type === 'item' && row.worktree.id === remoteWorker.id)
    ).toHaveLength(1)
  })

  it('leaves the remote worker top-level in its own section without an edge', () => {
    const rows = rowsFor([])
    const worker = findItem(rows, remoteWorker.id)
    const parent = findItem(rows, coordinator.id)
    expect(worker).toMatchObject({ depth: 0 })
    expect(worker?.sectionKey).not.toBe(parent?.sectionKey)
  })
})
