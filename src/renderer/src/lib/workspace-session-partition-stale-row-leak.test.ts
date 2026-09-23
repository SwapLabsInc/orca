import { describe, expect, it, vi } from 'vitest'
import type { SleepingAgentSessionRecord } from '../../../shared/agent-session-resume'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import {
  LOCAL_EXECUTION_HOST_ID,
  toSshExecutionHostId,
  type ExecutionHostId
} from '../../../shared/execution-host'
import { getDefaultWorkspaceSession } from '../../../shared/constants'
import { fetchWorkspaceSessionWithRuntimeHostOwners } from './workspace-session-host-hydration'
import {
  patchWorkspaceSessionByHost,
  type HostPersistenceState
} from './workspace-session-host-persistence'

/**
 * The accepted stale-row leak, pinned so a future revision cannot reintroduce the clear that used
 * to close it. See the KNOWN LIMITATION note on `patchWorkspaceSessionByHost`: a renderer-side
 * `{ field: {} }` deletes rows this renderer never saw, and leak beats kill
 * (docs/reference/ssh-execution-boundary.md).
 */

const SSH_TARGET_ID = 'ssh-1788980107277-d9gffw'
const SSH_HOST_ID = toSshExecutionHostId(SSH_TARGET_ID)
const OWNED_WORKTREE_ID = 'remote-repo::/srv/wt'
// The catalog has no row for this worktree, so only the record's own connectionId names its host.
const catalog = { repos: [], worktreesByRepo: {} } satisfies HostPersistenceState

const record: SleepingAgentSessionRecord = {
  paneKey: 'tab-1:leaf-1',
  tabId: 'tab-1',
  worktreeId: OWNED_WORKTREE_ID,
  connectionId: SSH_TARGET_ID,
  agent: 'claude',
  providerSession: { key: 'session_id', id: 'provider-1' },
  prompt: '',
  state: 'done',
  capturedAt: 1,
  updatedAt: 2
}
const withRecord = { sleepingAgentSessionsByPaneKey: { [record.paneKey]: record } }
const cleared = { sleepingAgentSessionsByPaneKey: {} }

function sshPatches(patch: ReturnType<typeof vi.fn>): unknown[] {
  return patch.mock.calls.filter(([, hostId]) => hostId === SSH_HOST_ID).map(([args]) => args)
}

function makeApi(partitions: Record<string, WorkspaceSessionState>) {
  const patch = vi.fn().mockResolvedValue(undefined)
  return {
    patch,
    api: {
      get: vi.fn(async (hostId?: string) => partitions[hostId ?? LOCAL_EXECUTION_HOST_ID] ?? {}),
      listHostIds: vi.fn(async (): Promise<ExecutionHostId[]> => [
        LOCAL_EXECUTION_HOST_ID,
        SSH_HOST_ID
      ]),
      patch,
      setSync: vi.fn()
    }
  }
}

describe('a sleeping-record field emptied on a non-local partition', () => {
  it('sends no clear to the ssh partition the last record left', async () => {
    const { api, patch } = makeApi({})
    await patchWorkspaceSessionByHost(api, withRecord, catalog)
    await patchWorkspaceSessionByHost(api, cleared, catalog)
    await new Promise((resolve) => setTimeout(resolve, 0))
    // The row write went out; the emptying patch names no ssh host, so the copy there survives.
    expect(sshPatches(patch)).toEqual([withRecord])
  })

  it('never clears a partition holding rows the boot merge parked', async () => {
    // The base holds terminal tabs for the workspace, so adoption declines the ssh rows for it and
    // this renderer's session never sees the record at all.
    const { api, patch } = makeApi({
      [LOCAL_EXECUTION_HOST_ID]: {
        ...getDefaultWorkspaceSession(),
        ...cleared,
        tabsByWorktree: {
          [OWNED_WORKTREE_ID]: [
            {
              id: 'tab-live',
              ptyId: null,
              worktreeId: OWNED_WORKTREE_ID,
              title: 't',
              customTitle: null,
              color: null,
              sortOrder: 0,
              createdAt: 1
            }
          ]
        }
      },
      [SSH_HOST_ID]: { ...getDefaultWorkspaceSession(), ...withRecord }
    })
    const read = await fetchWorkspaceSessionWithRuntimeHostOwners(api, [])
    expect(read.session.sleepingAgentSessionsByPaneKey ?? {}).toEqual({})

    await patchWorkspaceSessionByHost(api, cleared, catalog)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(sshPatches(patch)).toEqual([])
  })
})
