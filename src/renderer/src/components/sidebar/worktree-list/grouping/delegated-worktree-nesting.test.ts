import { describe, expect, it } from 'vitest'
import { getSettingsFocusedExecutionHostId } from '../../../../../../shared/execution-host'
import type { ExecutionHostId } from '../../../../../../shared/execution-host'
import { cloneDefaultWorkspaceStatuses } from '../../../../../../shared/workspace-statuses'
import { planSidebarRows } from '../../../../../../shared/sidebar-list/sidebar-row-plan'
import { createSidebarPRGroupReader } from './pr-group-key'
import { repo, remoteRepo, worktree } from '../../worktree-list-groups-test-fixtures'
import type { DelegatedWorktreeEdge } from '../../../../../../shared/worktree/delegated-worktree-edge'
import type { Repo } from '../../../../../../shared/repo-types'
import type { Worktree } from '../../../../../../shared/worktree/types'
import type {
  ImportedWorktreesCardCandidate,
  NewExternalWorktreesInboxCandidate,
  PendingCreationRef,
  Row,
  WorktreeGroupBy
} from '../../../../../../shared/sidebar-list/row-types'

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

// Why: a second, undelegated worktree in the child's repo is what gives that repo a
// section of its own, which is the case where the notice rows could be emitted twice.
const remoteSibling: Worktree = {
  ...worktree,
  id: 'repo-remote::/home/ubuntu/orca/sibling',
  repoId: remoteRepo.id,
  hostId: REMOTE_HOST,
  instanceId: 'sibling-instance',
  displayName: 'sibling'
}

const otherRepo: Repo = { ...remoteRepo, id: 'repo-other', displayName: 'other' }

// Why: a second coordinator in a different repo section, with its own delegated child of the
// same remote repo — the case where two sections each display a child of that repo.
const otherCoordinator: Worktree = {
  ...worktree,
  id: 'repo-other::/home/alex/orca/other-coordinator',
  repoId: otherRepo.id,
  hostId: 'local',
  instanceId: 'other-coordinator-instance',
  displayName: 'other-coordinator'
}

const secondRemoteWorker: Worktree = {
  ...worktree,
  id: 'repo-remote::/home/ubuntu/orca/worker-2',
  repoId: remoteRepo.id,
  hostId: REMOTE_HOST,
  instanceId: 'worker-2-instance',
  displayName: 'worker-2'
}

const edge: DelegatedWorktreeEdge = {
  parentWorktreeId: coordinator.id,
  childHostId: REMOTE_HOST,
  childWorktreeId: remoteWorker.id,
  dispatchId: 'ctx_1'
}

const repoMap = new Map([
  [repo.id, repo],
  [remoteRepo.id, remoteRepo],
  [otherRepo.id, otherRepo]
])

const notices = {
  importedWorktreesByRepo: new Map<string, ImportedWorktreesCardCandidate>([
    [remoteRepo.id, { repo: remoteRepo, hiddenWorktrees: [] }]
  ]),
  newExternalWorktreesInboxByRepo: new Map<string, NewExternalWorktreesInboxCandidate>([
    [remoteRepo.id, { repo: remoteRepo, inboxWorktrees: [] }]
  ]),
  pendingCreations: [{ creationId: 'create-1', repoId: remoteRepo.id }]
}

function rowsFor(
  edges: readonly DelegatedWorktreeEdge[],
  overrides: {
    groupBy?: WorktreeGroupBy
    defaultHostId?: ExecutionHostId
    importedWorktreesByRepo?: ReadonlyMap<string, ImportedWorktreesCardCandidate>
    newExternalWorktreesInboxByRepo?: ReadonlyMap<string, NewExternalWorktreesInboxCandidate>
    pendingCreations?: readonly PendingCreationRef[]
    worktrees?: readonly Worktree[]
  } = {}
): Row[] {
  const worktrees = [...(overrides.worktrees ?? [coordinator, remoteWorker])]
  return planSidebarRows({
    groupBy: overrides.groupBy ?? 'repo',
    worktrees,
    repoMap,
    prGroupOf: createSidebarPRGroupReader(repoMap, null),
    workspaceStatuses: cloneDefaultWorkspaceStatuses(),
    projectOrderBy: 'manual',
    lineageById: {},
    worktreeMap: new Map(worktrees.map((row) => [row.id, row])),
    nestLineage: true,
    projectGroups: [],
    placeholderRepoIds: new Set(),
    importedWorktreesByRepo: overrides.importedWorktreesByRepo ?? new Map(),
    newExternalWorktreesInboxByRepo: overrides.newExternalWorktreesInboxByRepo ?? new Map(),
    pendingCreations: overrides.pendingCreations ?? [],
    folderWorkspaces: [],
    defaultHostId: overrides.defaultHostId ?? 'local',
    pinnedDisplayPolicy: 'single-location',
    filterRepoIds: [],
    delegatedWorktreeEdges: edges
  }).render(new Set())
}

function findItem(
  rows: readonly Row[],
  worktreeId: string
): Extract<Row, { type: 'item' }> | undefined {
  return rows.find(
    (row): row is Extract<Row, { type: 'item' }> =>
      row.type === 'item' && row.worktree.id === worktreeId
  )
}

type NoticeRow = Extract<
  Row,
  { type: 'imported-worktrees-card' | 'new-external-worktrees-inbox' | 'pending-creation' }
>

function noticeRows(rows: readonly Row[]): NoticeRow[] {
  return rows.filter(
    (row): row is NoticeRow =>
      row.type === 'imported-worktrees-card' ||
      row.type === 'new-external-worktrees-inbox' ||
      row.type === 'pending-creation'
  )
}

function headerKeys(rows: readonly Row[]): string[] {
  return rows.flatMap((row) => (row.type === 'header' ? [row.key] : []))
}

describe('planSidebarRows with delegated edges', () => {
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

  it('still nests while a remote runtime environment is the focused host', () => {
    // Focus is a filter over every host's rows; the edges still come from this
    // window's own runtime, so the coordinator is still looked up as a local row.
    const rows = rowsFor([edge], {
      defaultHostId: getSettingsFocusedExecutionHostId({ activeRuntimeEnvironmentId: 'env-1' })
    })
    expect(findItem(rows, remoteWorker.id)).toMatchObject({ depth: 1 })
  })

  it('leaves the remote worker top-level in its own section without an edge', () => {
    const rows = rowsFor([])
    const worker = findItem(rows, remoteWorker.id)
    const parent = findItem(rows, coordinator.id)
    expect(worker).toMatchObject({ depth: 0 })
    expect(worker?.sectionKey).not.toBe(parent?.sectionKey)
  })

  it('follows a pinned coordinator into the Pinned section', () => {
    const pinnedCoordinator = { ...coordinator, isPinned: true }
    const rows = rowsFor([edge], { worktrees: [pinnedCoordinator, remoteWorker] })
    expect(findItem(rows, coordinator.id)).toMatchObject({ depth: 0 })
    expect(findItem(rows, remoteWorker.id)).toMatchObject({
      depth: 1,
      sectionKey: findItem(rows, coordinator.id)?.sectionKey
    })
  })

  it('nests within a status lane only when both share it', () => {
    const sameLane = rowsFor([edge], { groupBy: 'workspace-status' })
    expect(findItem(sameLane, remoteWorker.id)).toMatchObject({ depth: 1 })
    const rows = rowsFor([edge], {
      groupBy: 'workspace-status',
      worktrees: [{ ...coordinator, workspaceStatus: 'in-review' }, remoteWorker]
    })
    const worker = findItem(rows, remoteWorker.id)
    expect(worker).toMatchObject({ depth: 0 })
    expect(worker?.sectionKey).not.toBe(findItem(rows, coordinator.id)?.sectionKey)
  })

  it("keeps the worker's repo notices in that repo's own section, once", () => {
    // Upstream's rule for a child displayed under another project: the owning repo keeps its
    // notice rows, in a section of its own when no row of it is displayed there.
    const rows = rowsFor([edge], notices)
    const coordinatorSection = findItem(rows, coordinator.id)?.sectionKey
    const headers = headerKeys(rows)
    expect(headers).toHaveLength(2)
    expect(headers).toContain(coordinatorSection)
    expect(findItem(rows, remoteWorker.id)).toMatchObject({ sectionKey: coordinatorSection })
    const ownSection = headers.find((key) => key !== coordinatorSection)
    const ownSectionStart = rows.findIndex((row) => row.type === 'header' && row.key === ownSection)
    const ownSectionEnd = rows.findIndex(
      (row, index) => index > ownSectionStart && row.type === 'header'
    )
    const ownSectionRows = rows.slice(
      ownSectionStart + 1,
      ownSectionEnd === -1 ? undefined : ownSectionEnd
    )
    expect(noticeRows(ownSectionRows)).toHaveLength(3)
    expect(noticeRows(rows)).toHaveLength(3)
  })

  it("emits the child repo's notice rows once when that repo has its own section", () => {
    const rows = rowsFor([edge], {
      ...notices,
      worktrees: [coordinator, remoteWorker, remoteSibling]
    })
    const coordinatorSection = findItem(rows, coordinator.id)?.sectionKey
    expect(findItem(rows, remoteSibling.id)?.sectionKey).not.toBe(coordinatorSection)
    // The repo-keyed notice rows carry the same id in whichever section emits them, so a
    // second emission is a duplicate React key, not just a redundant card.
    const noticeKeys = noticeRows(rows).map((row) => row.key)
    expect(noticeKeys).toHaveLength(3)
    expect(new Set(noticeKeys).size).toBe(noticeKeys.length)
  })

  it('emits the notice rows once when two coordinators each nest a worker of one repo', () => {
    const secondEdge: DelegatedWorktreeEdge = {
      parentWorktreeId: otherCoordinator.id,
      childHostId: REMOTE_HOST,
      childWorktreeId: secondRemoteWorker.id,
      dispatchId: 'ctx_2'
    }
    const rows = rowsFor([edge, secondEdge], {
      ...notices,
      worktrees: [coordinator, remoteWorker, otherCoordinator, secondRemoteWorker]
    })
    expect(findItem(rows, secondRemoteWorker.id)).toMatchObject({
      depth: 1,
      sectionKey: findItem(rows, otherCoordinator.id)?.sectionKey
    })
    const noticeKeys = noticeRows(rows).map((row) => row.key)
    expect(noticeKeys).toHaveLength(3)
    expect(new Set(noticeKeys).size).toBe(noticeKeys.length)
  })
})
