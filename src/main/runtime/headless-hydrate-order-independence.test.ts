/**
 * A fresh headless host lists every persisted terminal tab whichever request reaches it first.
 *
 * A client-created pane binds a daemon-form PTY id (`<worktree>@@<id>`), which the runtime-only
 * hydrate does not count as its own. When a list or subscribe hydrated runtime-only first, the
 * full hydrate used to see a non-empty snapshot and skip, so the pane was never listed and its
 * activation failed — the order of a reconnecting client's first requests decided whether it
 * came back at all.
 */
import { describe, expect, it, vi } from 'vitest'

// Fragments stay side-effect ordered: mocks, then lifecycle, then fixtures.
const { OrcaRuntimeService } = await import('./orca-runtime-test-mocks.spec')
await import('./orca-runtime-test-lifecycle.spec')
const {
  HEADLESS_LEAF_ID,
  HEADLESS_SECOND_LEAF_ID,
  TEST_WORKTREE_ID,
  makeHeadlessTerminalLayout,
  makeRuntimeStoreWithWorkspaceSession,
  makeWorkspaceSessionWithHeadlessTerminal
} = await import('./orca-runtime-test-fixtures.spec')

const CLIENT_PTY_ID = `${TEST_WORKTREE_ID}@@AbCdEfGh`

function makeFreshHost() {
  const spawn = vi.fn(async (args: { sessionId?: string }) => ({
    id: args.sessionId ?? 'unexpected'
  }))
  const { runtimeStore } = makeRuntimeStoreWithWorkspaceSession(
    makeWorkspaceSessionWithHeadlessTerminal({
      tabsByWorktree: {
        [TEST_WORKTREE_ID]: [
          {
            id: 'serve-tab',
            ptyId: 'serve-plain-shell',
            worktreeId: TEST_WORKTREE_ID,
            title: 'Terminal 1',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 1
          },
          {
            id: 'client-tab',
            ptyId: CLIENT_PTY_ID,
            worktreeId: TEST_WORKTREE_ID,
            title: 'Terminal 2',
            customTitle: null,
            color: null,
            sortOrder: 1,
            createdAt: 2
          }
        ]
      },
      terminalLayoutsByTabId: {
        'serve-tab': makeHeadlessTerminalLayout({ [HEADLESS_LEAF_ID]: 'serve-plain-shell' }),
        'client-tab': makeHeadlessTerminalLayout({ [HEADLESS_SECOND_LEAF_ID]: CLIENT_PTY_ID })
      }
    })
  )
  const runtime = new OrcaRuntimeService(runtimeStore)
  runtime.setPtyController({
    spawn,
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => null,
    listProcesses: async () => []
  })
  runtime.syncWindowGraph(0, { tabs: [], leaves: [] })
  return { runtime, spawn }
}

function listedParentTabIds(result: { tabs: { type: string; parentTabId?: string }[] }) {
  return result.tabs.flatMap((tab) => (tab.type === 'terminal' ? [tab.parentTabId] : []))
}

describe('a fresh headless host', () => {
  it('lists and re-creates a client pane when a tab list reaches it first', async () => {
    const { runtime, spawn } = makeFreshHost()

    const listed = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)
    expect(listedParentTabIds(listed).sort()).toEqual(['client-tab', 'serve-tab'])

    await runtime.activateMobileSessionTab(
      `id:${TEST_WORKTREE_ID}`,
      `client-tab::${HEADLESS_SECOND_LEAF_ID}`,
      undefined,
      { notifyClients: false, intent: 'automatic' }
    )
    expect(spawn).toHaveBeenCalledWith(expect.objectContaining({ sessionId: CLIENT_PTY_ID }))
  })

  it('lists the same tabs when the activation reaches it first', async () => {
    const { runtime, spawn } = makeFreshHost()

    await runtime.activateMobileSessionTab(
      `id:${TEST_WORKTREE_ID}`,
      `client-tab::${HEADLESS_SECOND_LEAF_ID}`,
      undefined,
      { notifyClients: false, intent: 'automatic' }
    )
    expect(spawn).toHaveBeenCalledWith(expect.objectContaining({ sessionId: CLIENT_PTY_ID }))

    const listed = await runtime.listMobileSessionTabs(`id:${TEST_WORKTREE_ID}`)
    expect(listedParentTabIds(listed).sort()).toEqual(['client-tab', 'serve-tab'])
  })
})
