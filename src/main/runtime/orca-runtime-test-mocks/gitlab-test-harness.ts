import { vi, type Mock } from 'vitest'

// GitLab mocks shared by runtime specs through setup.spec.

type TestMock = Mock

const {
  listGitLabMergeRequestsMock,
  listGitLabWorkItemsMock,
  listGitLabIssuesMock,
  listGitLabLabelsMock,
  listGitLabAssignableUsersMock,
  listGitLabTodosMock,
  getGitLabProjectRefForRemoteMock,
  getGitLabWorkItemByProjectRefMock,
  createGitLabIssueMock,
  updateGitLabIssueMock,
  addGitLabIssueCommentMock,
  addGitLabMRCommentMock,
  addGitLabMRInlineCommentMock,
  resolveGitLabMRDiscussionMock,
  getGitLabJobTraceMock,
  retryGitLabJobMock,
  mergeGitLabMRMock,
  closeGitLabMRMock,
  reopenGitLabMRMock,
  updateGitLabMRMock,
  getGlabKnownHostsMock,
  getGitLabWorkItemDetailsMock,
  updateGitLabMRReviewersMock
} = vi.hoisted(() => {
  return {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: names the hoisted mock's type; the inferred one is not portable (TS2883).
    listGitLabMergeRequestsMock: vi.fn() as TestMock,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: names the hoisted mock's type; the inferred one is not portable (TS2883).
    listGitLabWorkItemsMock: vi.fn() as TestMock,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: names the hoisted mock's type; the inferred one is not portable (TS2883).
    listGitLabIssuesMock: vi.fn() as TestMock,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: names the hoisted mock's type; the inferred one is not portable (TS2883).
    listGitLabLabelsMock: vi.fn() as TestMock,
    listGitLabAssignableUsersMock: vi.fn<TestMock>(),
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: names the hoisted mock's type; the inferred one is not portable (TS2883).
    listGitLabTodosMock: vi.fn() as TestMock,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: names the hoisted mock's type; the inferred one is not portable (TS2883).
    getGitLabProjectRefForRemoteMock: vi.fn() as TestMock,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: names the hoisted mock's type; the inferred one is not portable (TS2883).
    getGitLabWorkItemByProjectRefMock: vi.fn() as TestMock,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: names the hoisted mock's type; the inferred one is not portable (TS2883).
    createGitLabIssueMock: vi.fn() as TestMock,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: names the hoisted mock's type; the inferred one is not portable (TS2883).
    updateGitLabIssueMock: vi.fn() as TestMock,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: names the hoisted mock's type; the inferred one is not portable (TS2883).
    addGitLabIssueCommentMock: vi.fn() as TestMock,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: names the hoisted mock's type; the inferred one is not portable (TS2883).
    addGitLabMRCommentMock: vi.fn() as TestMock,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: names the hoisted mock's type; the inferred one is not portable (TS2883).
    addGitLabMRInlineCommentMock: vi.fn() as TestMock,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: names the hoisted mock's type; the inferred one is not portable (TS2883).
    resolveGitLabMRDiscussionMock: vi.fn() as TestMock,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: names the hoisted mock's type; the inferred one is not portable (TS2883).
    getGitLabJobTraceMock: vi.fn() as TestMock,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: names the hoisted mock's type; the inferred one is not portable (TS2883).
    retryGitLabJobMock: vi.fn() as TestMock,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: names the hoisted mock's type; the inferred one is not portable (TS2883).
    mergeGitLabMRMock: vi.fn() as TestMock,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: names the hoisted mock's type; the inferred one is not portable (TS2883).
    closeGitLabMRMock: vi.fn() as TestMock,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: names the hoisted mock's type; the inferred one is not portable (TS2883).
    reopenGitLabMRMock: vi.fn() as TestMock,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: names the hoisted mock's type; the inferred one is not portable (TS2883).
    updateGitLabMRMock: vi.fn() as TestMock,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: names the hoisted mock's type; the inferred one is not portable (TS2883).
    getGlabKnownHostsMock: vi.fn() as TestMock,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: names the hoisted mock's type; the inferred one is not portable (TS2883).
    getGitLabWorkItemDetailsMock: vi.fn() as TestMock,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: names the hoisted mock's type; the inferred one is not portable (TS2883).
    updateGitLabMRReviewersMock: vi.fn() as TestMock
  }
})

vi.mock('../../gitlab/work-items/work-item-details', async (importOriginal) => {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: importOriginal resolves to the module namespace, spread unchanged into the mock.
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    getWorkItemDetails: getGitLabWorkItemDetailsMock
  }
})

vi.mock(import('../../gitlab/merge-requests/merge-request-list'), async (importOriginal) => ({
  ...(await importOriginal()),
  listMergeRequests: listGitLabMergeRequestsMock
}))

vi.mock(import('../../gitlab/work-items/work-item-queries'), async (importOriginal) => ({
  ...(await importOriginal()),
  listWorkItems: listGitLabWorkItemsMock,
  listTodos: listGitLabTodosMock,
  getWorkItemByProjectRef: getGitLabWorkItemByProjectRefMock
}))

vi.mock(import('../../gitlab/issues/gitlab-issue-queries'), async (importOriginal) => ({
  ...(await importOriginal()),
  listIssues: listGitLabIssuesMock,
  createIssue: createGitLabIssueMock,
  addIssueComment: addGitLabIssueCommentMock
}))

vi.mock(
  import('../../gitlab/projects/project-label-and-member-lookup'),
  async (importOriginal) => ({
    ...(await importOriginal()),
    listLabels: listGitLabLabelsMock,
    listAssignableUsers: listGitLabAssignableUsersMock
  })
)

vi.mock(import('../../gitlab/projects/gitlab-project-ref-resolution'), async (importOriginal) => ({
  ...(await importOriginal()),
  getProjectRefForRemote: getGitLabProjectRefForRemoteMock
}))

vi.mock(import('../../gitlab/issues/issue-update'), async (importOriginal) => ({
  ...(await importOriginal()),
  updateIssue: updateGitLabIssueMock
}))

vi.mock(
  import('../../gitlab/merge-requests/merge-request-review-mutations'),
  async (importOriginal) => ({
    ...(await importOriginal()),
    addMRComment: addGitLabMRCommentMock,
    addMRInlineComment: addGitLabMRInlineCommentMock,
    resolveMRDiscussion: resolveGitLabMRDiscussionMock,
    updateMRReviewers: updateGitLabMRReviewersMock
  })
)

vi.mock(import('../../gitlab/pipelines/pipeline-job-mutations'), async (importOriginal) => ({
  ...(await importOriginal()),
  getJobTrace: getGitLabJobTraceMock,
  retryJob: retryGitLabJobMock
}))

vi.mock(
  import('../../gitlab/merge-requests/merge-request-state-mutations'),
  async (importOriginal) => ({
    ...(await importOriginal()),
    mergeMR: mergeGitLabMRMock,
    closeMR: closeGitLabMRMock,
    reopenMR: reopenGitLabMRMock
  })
)

vi.mock(import('../../gitlab/merge-requests/merge-request-update'), async (importOriginal) => ({
  ...(await importOriginal()),
  updateMR: updateGitLabMRMock
}))

vi.mock(import('../../gitlab/projects/gitlab-known-host-probe'), async (importOriginal) => ({
  ...(await importOriginal()),
  getGlabKnownHosts: getGlabKnownHostsMock
}))

export {
  listGitLabMergeRequestsMock,
  listGitLabWorkItemsMock,
  listGitLabIssuesMock,
  listGitLabLabelsMock,
  listGitLabAssignableUsersMock,
  listGitLabTodosMock,
  getGitLabProjectRefForRemoteMock,
  getGitLabWorkItemByProjectRefMock,
  createGitLabIssueMock,
  updateGitLabIssueMock,
  addGitLabIssueCommentMock,
  addGitLabMRCommentMock,
  addGitLabMRInlineCommentMock,
  resolveGitLabMRDiscussionMock,
  getGitLabJobTraceMock,
  retryGitLabJobMock,
  mergeGitLabMRMock,
  closeGitLabMRMock,
  reopenGitLabMRMock,
  updateGitLabMRMock,
  getGlabKnownHostsMock,
  getGitLabWorkItemDetailsMock,
  updateGitLabMRReviewersMock
}
