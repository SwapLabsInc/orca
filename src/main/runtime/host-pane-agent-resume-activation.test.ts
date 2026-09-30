/**
 * A pane whose terminal the host lost is re-created by the next activation; the host itself decides
 * whether the agent that pane last ran comes back, from its own agent-status store.
 */
import { describe, expect, it, vi } from 'vitest'
import { makePaneKey } from '../../shared/stable-pane-id'
import { makeAgentStatusStoreWiring } from './agent-status-store-wiring.test-fixture'

// Fragments stay side-effect ordered: mocks, then lifecycle, then fixtures.
const { OrcaRuntimeService } = await import('./orca-runtime-test-mocks.spec')
await import('./orca-runtime-test-lifecycle.spec')
const {
  HEADLESS_LEAF_ID,
  HEADLESS_SECOND_LEAF_ID,
  TEST_WORKTREE_ID,
  makeHeadlessTerminalLayout,
  makeRuntimeStoreWithWorkspaceSession,
  makeWorkspaceSessionWithHeadlessTerminal,
  store
} = await import('./orca-runtime-test-fixtures.spec')

const PANE_KEY = makePaneKey('host-tab', HEADLESS_LEAF_ID)
const SESSION = 'c0ffee00-0000-4000-8000-00000000000a'
const TAB_ID = `host-tab::${HEADLESS_LEAF_ID}`

type SpawnArgs = { sessionId?: string; command?: string }
type Spawn = (args: SpawnArgs) => Promise<{ id: string }>

function makeLostPaneRuntime(opts: { launchAgent?: 'claude'; spawn?: Spawn } = {}) {
  const statusWiring = makeAgentStatusStoreWiring()
  const spawn = vi.fn<Spawn>(opts.spawn ?? (async () => ({ id: 'serve-dead-pty' })))
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
            createdAt: 1,
            ...(opts.launchAgent ? { launchAgent: opts.launchAgent } : {})
          }
        ]
      },
      terminalLayoutsByTabId: {
        'host-tab': makeHeadlessTerminalLayout({ [HEADLESS_LEAF_ID]: 'serve-dead-pty' })
      }
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
  const livePtyIds = new Set(['other-pty'])
  const trackedSpawn = vi.fn(async (args: SpawnArgs) => {
    const result = await spawn(args)
    livePtyIds.add(result.id)
    return result
  })
  runtime.setPtyController({
    spawn: trackedSpawn,
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => null,
    // Why: the host's inventory is what tells a live pane from a lost one.
    listProcesses: async () => [...livePtyIds].map((id) => ({ id, cwd: '', title: 'bash' }))
  })
  runtime.syncWindowGraph(0, { tabs: [], leaves: [] })
  return { runtime, spawn, statusStore: statusWiring.statusStore }
}

function reportClaudeSession(
  statusStore: ReturnType<typeof makeAgentStatusStoreWiring>['statusStore'],
  paneKey = PANE_KEY,
  sessionId = SESSION
): void {
  statusStore.ingestRemote(
    {
      paneKey,
      tabId: paneKey.split(':')[0],
      worktreeId: TEST_WORKTREE_ID,
      source: 'claude',
      hookEventName: 'Stop',
      providerSession: { key: 'session_id', id: sessionId },
      payload: { state: 'done', prompt: 'ship it', agentType: 'claude' }
    },
    null
  )
}

function activate(runtime: InstanceType<typeof OrcaRuntimeService>) {
  return runtime.activateMobileSessionTab(`id:${TEST_WORKTREE_ID}`, TAB_ID, undefined, {
    notifyClients: false,
    intent: 'automatic'
  })
}

describe('re-creating a pane whose terminal was lost', () => {
  it("resumes the pane's agent with the host's own launch settings", async () => {
    const { runtime, spawn, statusStore } = makeLostPaneRuntime()
    reportClaudeSession(statusStore)

    const activated = await activate(runtime)

    expect(spawn).toHaveBeenCalledOnce()
    expect(spawn.mock.calls[0]![0]).toMatchObject({
      sessionId: 'serve-dead-pty',
      tabId: 'host-tab',
      leafId: HEADLESS_LEAF_ID,
      launchAgent: 'claude',
      resumeProviderSession: { key: 'session_id', id: SESSION }
    })
    expect(spawn.mock.calls[0]![0].command).toMatch(
      new RegExp(`^claude .*--dangerously-skip-permissions.*--model.*opus.*--resume.*${SESSION}`)
    )
    expect(activated.tabs[0]).toMatchObject({
      type: 'terminal',
      status: 'ready',
      launchAgent: 'claude'
    })
    statusStore.stop()
  })

  it('opens a plain shell for an agent the user ended, even under an agent tab', async () => {
    const { runtime, spawn, statusStore } = makeLostPaneRuntime({ launchAgent: 'claude' })
    reportClaudeSession(statusStore)
    statusStore.reconcileEndedProcessForPaneKeys([PANE_KEY], { preserveResumeIdentity: true })

    await activate(runtime)

    expect(spawn).toHaveBeenCalledOnce()
    expect(spawn.mock.calls[0]![0].command).toBeUndefined()
    statusStore.stop()
  })

  it('opens a plain shell for a pane that never ran an agent', async () => {
    const { runtime, spawn, statusStore } = makeLostPaneRuntime()

    await activate(runtime)

    expect(spawn).toHaveBeenCalledOnce()
    expect(spawn.mock.calls[0]![0].command).toBeUndefined()
    statusStore.stop()
  })

  it('leaves a session to the pane whose terminal still runs it', async () => {
    const { runtime, spawn, statusStore } = makeLostPaneRuntime()
    runtime.registerPty('other-pty', TEST_WORKTREE_ID, null, {
      tabId: 'other-tab',
      leafId: HEADLESS_SECOND_LEAF_ID
    })
    // Why the older row: only the other pane's live terminal may keep the session from this one.
    reportClaudeSession(statusStore, makePaneKey('other-tab', HEADLESS_SECOND_LEAF_ID))
    reportClaudeSession(statusStore)

    await activate(runtime)

    expect(spawn).toHaveBeenCalledOnce()
    expect(spawn.mock.calls[0]![0].command).toBeUndefined()
    statusStore.stop()
  })

  it('launches once when several clients re-create the pane at the same time', async () => {
    let finishSpawn!: (value: { id: string }) => void
    const { runtime, spawn, statusStore } = makeLostPaneRuntime({
      spawn: () => new Promise<{ id: string }>((resolve) => (finishSpawn = resolve))
    })
    reportClaudeSession(statusStore)

    const first = activate(runtime)
    const second = activate(runtime)
    const third = runtime.activateMobileSessionTab(`id:${TEST_WORKTREE_ID}`, TAB_ID)
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce())
    finishSpawn({ id: 'serve-dead-pty' })
    const results = await Promise.all([first, second, third])

    expect(spawn).toHaveBeenCalledOnce()
    expect(spawn.mock.calls[0]![0].command).toContain('--resume')
    for (const result of results) {
      expect(result.tabs[0]).toMatchObject({ status: 'ready' })
    }
    statusStore.stop()
  })

  it('falls back to a shell when the resume spawn is refused, and keeps the session', async () => {
    let calls = 0
    const { runtime, spawn, statusStore } = makeLostPaneRuntime({
      spawn: async () => {
        calls += 1
        if (calls === 1) {
          throw new Error('claude auth switch in progress')
        }
        return { id: 'serve-dead-pty' }
      }
    })
    reportClaudeSession(statusStore)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const activated = await activate(runtime)

    expect(spawn).toHaveBeenCalledTimes(2)
    expect(spawn.mock.calls[0]![0].command).toContain('--resume')
    expect(spawn.mock.calls[1]![0].command).toBeUndefined()
    expect(activated.tabs[0]).toMatchObject({ status: 'ready' })
    expect(statusStore.selectTerminalLossResume(PANE_KEY, () => false)).toMatchObject({
      providerSession: { id: SESSION }
    })
    warn.mockRestore()
    statusStore.stop()
  })
})
