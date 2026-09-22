/** A pane's sleeping record is its only resume handle after a host restart, so a status update
 *  that carries no resume identity must leave it alone (#22270). */
import { describe, expect, it } from 'vitest'
import { MAX_LIVE_AGENT_STATUSES } from './agent-status'
import { createTestStore, makeTab, seedStore } from './store-test-helpers'

function seedTab(store: ReturnType<typeof createTestStore>, rootedLeafId?: string): void {
  seedStore(store, {
    tabsByWorktree: {
      'wt-1': [makeTab({ id: 'tab-1', worktreeId: 'wt-1' })]
    },
    ...(rootedLeafId
      ? {
          terminalLayoutsByTabId: {
            'tab-1': {
              root: { type: 'leaf' as const, leafId: rootedLeafId },
              activeLeafId: rootedLeafId,
              expandedLeafId: null
            }
          }
        }
      : {})
  })
}

/** A finished Claude pane whose resumable identity is checkpointed as a live record. */
function seedResumableDonePane(store: ReturnType<typeof createTestStore>): void {
  store
    .getState()
    .setAgentStatus(
      'tab-1:leaf-1',
      { state: 'done', prompt: 'ship the fix', agentType: 'claude' },
      'Claude',
      { updatedAt: 100, stateStartedAt: 100 },
      { tabId: 'tab-1', worktreeId: 'wt-1' },
      { providerSession: { key: 'session_id', id: 'claude-session-1' } }
    )
}

describe('sleeping record retirement on live status updates', () => {
  it('retains the record when the update carries no provider session', () => {
    const store = createTestStore()
    seedTab(store)
    seedResumableDonePane(store)
    expect(store.getState().sleepingAgentSessionsByPaneKey['tab-1:leaf-1']).toBeDefined()

    // An OSC-parsed row knows the pane is working again but nothing about its session id.
    store
      .getState()
      .setAgentStatus(
        'tab-1:leaf-1',
        { state: 'working', prompt: 'ship the fix', agentType: 'claude' },
        'Claude',
        { updatedAt: 200, stateStartedAt: 200 },
        { tabId: 'tab-1', worktreeId: 'wt-1' }
      )

    expect(store.getState().sleepingAgentSessionsByPaneKey['tab-1:leaf-1']).toMatchObject({
      agent: 'claude',
      providerSession: { key: 'session_id', id: 'claude-session-1' }
    })
  })

  // EP-CONFIG: a retained handle whose launch config was dropped resumes with default flags.
  it('keeps the launch config of a restored pane whose record is retained', () => {
    const store = createTestStore()
    seedTab(store)
    // A restored session: the record and the spawn-time registry entry exist before any status row.
    seedStore(store, {
      sleepingAgentSessionsByPaneKey: {
        'tab-1:leaf-1': {
          paneKey: 'tab-1:leaf-1',
          tabId: 'tab-1',
          worktreeId: 'wt-1',
          agent: 'claude',
          providerSession: { key: 'session_id', id: 'claude-session-1' },
          prompt: 'ship the fix',
          state: 'working',
          capturedAt: 10,
          updatedAt: 10,
          origin: 'live'
        }
      },
      agentLaunchConfigByPaneKey: {
        'tab-1:leaf-1': {
          launchConfig: { agentArgs: '--dangerously-skip-permissions', agentEnv: {} },
          registeredAt: 10,
          identity: { agentType: 'claude', tabId: 'tab-1', leafId: 'leaf-1' }
        }
      }
    })

    store
      .getState()
      .setAgentStatus(
        'tab-1:leaf-1',
        { state: 'done', prompt: 'ship the fix', agentType: 'claude' },
        'Claude',
        { updatedAt: 200, stateStartedAt: 200 },
        { tabId: 'tab-1', worktreeId: 'wt-1' }
      )

    expect(store.getState().sleepingAgentSessionsByPaneKey['tab-1:leaf-1']).toMatchObject({
      providerSession: { key: 'session_id', id: 'claude-session-1' }
    })
    expect(store.getState().agentLaunchConfigByPaneKey['tab-1:leaf-1']?.launchConfig).toEqual({
      agentArgs: '--dangerously-skip-permissions',
      agentEnv: {}
    })
  })

  it('retires the record when the host states the pane is not resumable', () => {
    const store = createTestStore()
    seedTab(store)
    seedResumableDonePane(store)

    store
      .getState()
      .setAgentStatus(
        'tab-1:leaf-1',
        { state: 'working', prompt: 'ship the fix', agentType: 'claude' },
        'Claude',
        { updatedAt: 200, stateStartedAt: 200 },
        { tabId: 'tab-1', worktreeId: 'wt-1' },
        { terminalResumeEligible: false }
      )

    expect(store.getState().sleepingAgentSessionsByPaneKey['tab-1:leaf-1']).toBeUndefined()
  })

  it('retires the record when a superseding provider session yields no resumable record', () => {
    const store = createTestStore()
    seedTab(store)
    // Pi resumes by transcript file, so a session reported without one is unresumable.
    store.getState().setAgentStatus(
      'tab-1:leaf-1',
      { state: 'working', prompt: 'ship the fix', agentType: 'pi' },
      'Pi',
      { updatedAt: 100, stateStartedAt: 100 },
      { tabId: 'tab-1', worktreeId: 'wt-1' },
      {
        providerSession: {
          key: 'session_id',
          id: 'pi-session-1',
          transcriptPath: '/sessions/pi-session-1.jsonl'
        }
      }
    )
    expect(store.getState().sleepingAgentSessionsByPaneKey['tab-1:leaf-1']).toBeDefined()

    store
      .getState()
      .setAgentStatus(
        'tab-1:leaf-1',
        { state: 'working', prompt: 'next task', agentType: 'pi' },
        'Pi',
        { updatedAt: 200, stateStartedAt: 200 },
        { tabId: 'tab-1', worktreeId: 'wt-1' },
        { providerSession: { key: 'session_id', id: 'pi-session-2' } }
      )

    expect(store.getState().sleepingAgentSessionsByPaneKey['tab-1:leaf-1']).toBeUndefined()
  })

  it('EP-STATE: an older replayed update does not destroy the newer update’s record', () => {
    const store = createTestStore()
    seedTab(store)
    seedResumableDonePane(store)
    const written = store.getState().sleepingAgentSessionsByPaneKey['tab-1:leaf-1']
    expect(written?.providerSession.id).toBe('claude-session-1')

    // A relay cached-pane-status replay lands after the hook event it predates.
    store
      .getState()
      .setAgentStatus(
        'tab-1:leaf-1',
        { state: 'working', prompt: 'ship the fix', agentType: 'claude' },
        'Claude',
        { updatedAt: 50, stateStartedAt: 50, allowOlderTimestamp: true },
        { tabId: 'tab-1', worktreeId: 'wt-1' }
      )

    // Volatile fields follow the row the store accepted; the resume identity the newer update
    // authorized is what the older frame must not be able to destroy.
    expect(store.getState().sleepingAgentSessionsByPaneKey['tab-1:leaf-1']).toMatchObject({
      agent: written!.agent,
      providerSession: written!.providerSession,
      worktreeId: written!.worktreeId,
      tabId: written!.tabId,
      capturedAt: written!.capturedAt,
      origin: written!.origin
    })
  })

  it('keeps origin and capture time while volatile fields track the pane', () => {
    const store = createTestStore()
    seedTab(store)
    seedResumableDonePane(store)
    const written = store.getState().sleepingAgentSessionsByPaneKey['tab-1:leaf-1']
    expect(written).toMatchObject({ state: 'done', prompt: '', origin: 'live', capturedAt: 100 })

    store
      .getState()
      .setAgentStatus(
        'tab-1:leaf-1',
        { state: 'working', prompt: 'next task', agentType: 'claude' },
        'Claude',
        { updatedAt: 300, stateStartedAt: 300 },
        { tabId: 'tab-1', worktreeId: 'wt-1' }
      )

    expect(store.getState().sleepingAgentSessionsByPaneKey['tab-1:leaf-1']).toMatchObject({
      state: 'working',
      prompt: 'next task',
      updatedAt: 300,
      // Restamping would quietly change which record counts as a durable capture.
      capturedAt: 100,
      origin: 'live',
      providerSession: { key: 'session_id', id: 'claude-session-1' }
    })
  })

  it('retires the record when the pane switches to a different agent', () => {
    const store = createTestStore()
    seedTab(store)
    seedResumableDonePane(store)

    store
      .getState()
      .setAgentStatus(
        'tab-1:leaf-1',
        { state: 'working', prompt: 'next task', agentType: 'codex' },
        'Codex',
        { updatedAt: 200, stateStartedAt: 200 },
        { tabId: 'tab-1', worktreeId: 'wt-1' }
      )

    expect(store.getState().sleepingAgentSessionsByPaneKey['tab-1:leaf-1']).toBeUndefined()
  })

  it('still drops the record for a pane the capacity cap evicts', () => {
    const store = createTestStore()
    seedTab(store, 'leaf-live')
    store
      .getState()
      .setAgentStatus(
        'tab-1:leaf-evictable',
        { state: 'working', prompt: 'ship the fix', agentType: 'claude' },
        'Claude',
        { updatedAt: 100, stateStartedAt: 100 },
        { tabId: 'tab-1', worktreeId: 'wt-1' },
        { providerSession: { key: 'session_id', id: 'claude-session-1' } }
      )
    expect(store.getState().sleepingAgentSessionsByPaneKey['tab-1:leaf-evictable']).toBeDefined()

    for (let i = 0; i < MAX_LIVE_AGENT_STATUSES + 10; i += 1) {
      store
        .getState()
        .setAgentStatus(
          `tab-1:dead-${i}`,
          { state: 'done', prompt: `prompt ${i}`, agentType: 'claude' },
          'Claude',
          { updatedAt: 200 + i, stateStartedAt: 200 + i },
          { tabId: 'tab-1', worktreeId: 'wt-1' }
        )
    }

    expect(store.getState().agentStatusByPaneKey['tab-1:leaf-evictable']).toBeUndefined()
    expect(store.getState().sleepingAgentSessionsByPaneKey['tab-1:leaf-evictable']).toBeUndefined()
  })
})
