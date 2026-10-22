/**
 * Upstream first: a re-created pane that has a sleeping record starts the way upstream's record
 * rule decides, even when the host's hook store also names a session for it. The hook-store resume
 * is only the fallback for a pane with no record at all.
 */
import { describe, expect, it, vi } from 'vitest'
import type { SleepingAgentSessionRecord } from '../../shared/agent-session-resume'
import { makePaneKey } from '../../shared/stable-pane-id'
import { makeAgentStatusStoreWiring } from './agent-status-store-wiring.test-fixture'

// Fragments stay side-effect ordered: mocks, then lifecycle, then fixtures.
const { OrcaRuntimeService } = await import('./orca-runtime-test-mocks.spec')
await import('./orca-runtime-test-lifecycle.spec')
const {
  HEADLESS_LEAF_ID,
  TEST_WORKTREE_ID,
  makeHeadlessTerminalLayout,
  makeRuntimeStoreWithWorkspaceSession,
  makeWorkspaceSessionWithHeadlessTerminal,
  store
} = await import('./orca-runtime-test-fixtures.spec')

const PANE_KEY = makePaneKey('host-tab', HEADLESS_LEAF_ID)
const RECORDED = 'c0ffee00-0000-4000-8000-00000000001a'
const NEWER = 'c0ffee00-0000-4000-8000-00000000001b'

type SpawnArgs = { command?: string; resumeProviderSession?: { id: string } }

function sleepingRecord(origin: SleepingAgentSessionRecord['origin']): SleepingAgentSessionRecord {
  return {
    paneKey: PANE_KEY,
    tabId: 'host-tab',
    worktreeId: TEST_WORKTREE_ID,
    agent: 'claude',
    providerSession: { key: 'session_id', id: RECORDED },
    prompt: 'ship it',
    state: 'done',
    capturedAt: 1,
    updatedAt: 1,
    ...(origin ? { origin } : {})
  }
}

function makeRuntime(record: SleepingAgentSessionRecord) {
  const statusWiring = makeAgentStatusStoreWiring()
  const spawn = vi.fn(async (_args: SpawnArgs) => ({ id: 'serve-dead-pty' }))
  const { runtimeStore } = makeRuntimeStoreWithWorkspaceSession(
    makeWorkspaceSessionWithHeadlessTerminal({
      tabsByWorktree: {
        [TEST_WORKTREE_ID]: [
          {
            id: 'host-tab',
            ptyId: 'serve-dead-pty',
            worktreeId: TEST_WORKTREE_ID,
            title: 'Terminal 1',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 1
          }
        ]
      },
      terminalLayoutsByTabId: {
        'host-tab': makeHeadlessTerminalLayout({ [HEADLESS_LEAF_ID]: 'serve-dead-pty' })
      },
      sleepingAgentSessionsByPaneKey: { [PANE_KEY]: record }
    })
  )
  const runtime = new OrcaRuntimeService(
    {
      ...runtimeStore,
      getSettings: () => ({
        ...store.getSettings(),
        disabledTuiAgents: [],
        agentDefaultArgs: { claude: '--dangerously-skip-permissions --model opus' }
      })
    },
    undefined,
    statusWiring.deps
  )
  const live = new Set<string>()
  runtime.setPtyController({
    spawn: async (args: SpawnArgs) => {
      const result = await spawn(args)
      live.add(result.id)
      return result
    },
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => null,
    listProcesses: async () => [...live].map((id) => ({ id, cwd: '', title: 'bash' }))
  })
  runtime.syncWindowGraph(0, { tabs: [], leaves: [] })
  const reportClaudeSession = (sessionId: string): void =>
    statusWiring.statusStore.ingestRemote(
      {
        paneKey: PANE_KEY,
        tabId: 'host-tab',
        worktreeId: TEST_WORKTREE_ID,
        source: 'claude',
        hookEventName: 'Stop',
        providerSession: { key: 'session_id', id: sessionId },
        payload: { state: 'done', prompt: 'ship it', agentType: 'claude' }
      },
      null
    )
  const activate = () =>
    runtime.activateMobileSessionTab(
      `id:${TEST_WORKTREE_ID}`,
      `host-tab::${HEADLESS_LEAF_ID}`,
      undefined,
      {
        notifyClients: false,
        intent: 'user'
      }
    )
  return { activate, spawn, reportClaudeSession, statusStore: statusWiring.statusStore }
}

describe('a re-created pane with a sleeping record', () => {
  it('resumes from its record with the recorded flags, not the hook store settings', async () => {
    const { activate, spawn, reportClaudeSession, statusStore } = makeRuntime(
      sleepingRecord('live')
    )
    reportClaudeSession(RECORDED)

    await activate()

    expect(spawn).toHaveBeenCalledOnce()
    expect(spawn.mock.calls[0]![0].resumeProviderSession).toMatchObject({ id: RECORDED })
    expect(spawn.mock.calls[0]![0].command).toContain(RECORDED)
    // Why: the hook-store fallback would have resumed with the settings default bypass.
    expect(spawn.mock.calls[0]![0].command).not.toContain('--dangerously-skip-permissions')
    statusStore.stop()
  })

  it("keeps upstream's plain shell when the hook store names a newer session", async () => {
    const { activate, spawn, reportClaudeSession, statusStore } = makeRuntime(
      sleepingRecord('live')
    )
    reportClaudeSession(NEWER)

    await activate()

    expect(spawn).toHaveBeenCalledOnce()
    expect(spawn.mock.calls[0]![0].command).toBeUndefined()
    statusStore.stop()
  })

  it('leaves an originless legacy record alone instead of resuming the hook store session', async () => {
    const { activate, spawn, reportClaudeSession, statusStore } = makeRuntime(
      sleepingRecord(undefined)
    )
    reportClaudeSession(NEWER)

    await activate()

    expect(spawn).toHaveBeenCalledOnce()
    expect(spawn.mock.calls[0]![0].command).toBeUndefined()
    statusStore.stop()
  })
})
