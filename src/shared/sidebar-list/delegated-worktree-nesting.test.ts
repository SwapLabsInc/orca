import { describe, expect, it } from 'vitest'
import type { DelegatedWorktreeEdge } from '../worktree/delegated-worktree-edge'
import { getWorktreeHostIdentity } from '../worktree/host-qualified-identity'
import type { WorktreeLineage } from '../worktree/lineage-types'
import type { Worktree } from '../worktree/types'
import {
  resolveDelegatedWorktreeNesting,
  withDelegatedWorktreeChildren
} from './delegated-worktree-nesting'

const REMOTE_HOST = 'runtime:env-1' as const

function worktree(overrides: Partial<Worktree>): Worktree {
  return {
    id: 'repo-1::/r/a',
    repoId: 'repo-1',
    path: '/r/a',
    head: 'abc',
    branch: 'refs/heads/a',
    isBare: false,
    isMainWorktree: false,
    displayName: 'a',
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    ...overrides
  }
}

const coordinator = worktree({
  id: 'repo-1::/home/alex/orca/coordinator',
  hostId: 'local',
  instanceId: 'coordinator-instance'
})

const remoteWorker = worktree({
  id: 'repo-remote::/home/ubuntu/orca/worker',
  repoId: 'repo-remote',
  hostId: REMOTE_HOST,
  instanceId: 'worker-instance'
})

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
  })
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
    const resolved = resolveDelegatedWorktreeNesting({
      worktrees: [coordinator, remoteWorker],
      edges: [{ ...edge, dispatchId: 'ctx_2' }],
      homeHostId: REMOTE_HOST,
      // The coordinator is itself a child of the worker in this shape.
      getLineageParentIdentity: (candidate) =>
        candidate.id === coordinator.id ? `${REMOTE_HOST}|${remoteWorker.id}` : undefined
    })
    expect(resolved.size).toBe(0)
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

describe('withDelegatedWorktreeChildren', () => {
  const localChild = worktree({
    id: 'repo-1::/home/alex/orca/local-child',
    hostId: 'local',
    instanceId: 'local-child-instance'
  })

  it('adds the delegated worker beside the lineage children it does not replace', () => {
    const lineageChildren = new Map<string, Worktree[]>([
      [getWorktreeHostIdentity(coordinator), [localChild]]
    ])
    const merged = withDelegatedWorktreeChildren(lineageChildren, {
      worktrees: [coordinator, localChild, remoteWorker],
      lineageById: {},
      worktreeMap: new Map(),
      delegatedWorktreeEdges: [edge]
    })
    expect(merged.get(getWorktreeHostIdentity(coordinator))).toEqual([localChild, remoteWorker])
    expect(lineageChildren.get(getWorktreeHostIdentity(coordinator))).toEqual([localChild])
  })

  it('returns the lineage map itself when nothing was delegated', () => {
    const lineageChildren = new Map<string, Worktree[]>()
    const inputs = {
      worktrees: [coordinator, remoteWorker],
      lineageById: {},
      worktreeMap: new Map()
    }
    expect(withDelegatedWorktreeChildren(lineageChildren, inputs)).toBe(lineageChildren)
    expect(
      withDelegatedWorktreeChildren(lineageChildren, { ...inputs, delegatedWorktreeEdges: [] })
    ).toBe(lineageChildren)
  })

  it('lets a lineage parent that is not on screen outrank the edge', () => {
    const remoteParent = worktree({
      id: 'repo-remote::/home/ubuntu/orca/parent',
      repoId: 'repo-remote',
      hostId: REMOTE_HOST,
      instanceId: 'remote-parent-instance'
    })
    const lineage: WorktreeLineage = {
      worktreeId: remoteWorker.id,
      worktreeInstanceId: 'worker-instance',
      parentWorktreeId: remoteParent.id,
      parentWorktreeInstanceId: 'remote-parent-instance',
      origin: 'manual',
      capture: { source: 'manual-action', confidence: 'explicit' },
      createdAt: 1
    }
    const lineageChildren = new Map<string, Worktree[]>()
    const merged = withDelegatedWorktreeChildren(lineageChildren, {
      worktrees: [coordinator, remoteWorker],
      lineageById: { [remoteWorker.id]: lineage },
      worktreeMap: new Map([[remoteParent.id, remoteParent]]),
      delegatedWorktreeEdges: [edge]
    })
    expect(merged).toBe(lineageChildren)
  })
})
