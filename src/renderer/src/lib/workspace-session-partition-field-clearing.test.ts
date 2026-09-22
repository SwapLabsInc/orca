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
  buildWorkspaceSessionHostSnapshots,
  patchWorkspaceSessionByHost,
  type HostPersistenceState
} from './workspace-session-host-persistence'

const SSH_TARGET_ID = 'ssh-1788980107277-d9gffw'
const SSH_HOST_ID = toSshExecutionHostId(SSH_TARGET_ID)
// The catalog has no row for this worktree, so only the record's own connectionId names its host.
const catalog = {
  repos: [],
  worktreesByRepo: {}
} satisfies HostPersistenceState

const record: SleepingAgentSessionRecord = {
  paneKey: 'tab-1:leaf-1',
  tabId: 'tab-1',
  worktreeId: 'remote-repo::/srv/wt',
  connectionId: SSH_TARGET_ID,
  agent: 'claude',
  providerSession: { key: 'session_id', id: 'provider-1' },
  prompt: '',
  state: 'done',
  capturedAt: 1,
  updatedAt: 2
}
const withRecord = {
  sleepingAgentSessionsByPaneKey: { [record.paneKey]: record }
}
const cleared = { sleepingAgentSessionsByPaneKey: {} }

function makeApi(patch = vi.fn().mockResolvedValue(undefined)) {
  return { api: { get: vi.fn(), patch, setSync: vi.fn() }, patch }
}

/** The boot read as it reaches the write path: one ssh partition already holding the record. */
function makeReadApi(patch = vi.fn().mockResolvedValue(undefined)) {
  const partitions: Record<string, WorkspaceSessionState> = {
    [LOCAL_EXECUTION_HOST_ID]: { ...getDefaultWorkspaceSession(), ...cleared },
    [SSH_HOST_ID]: { ...getDefaultWorkspaceSession(), ...withRecord }
  }
  return {
    api: {
      get: vi.fn(async (hostId?: string) => partitions[hostId ?? LOCAL_EXECUTION_HOST_ID] ?? {}),
      listHostIds: vi.fn(async (): Promise<ExecutionHostId[]> => [
        LOCAL_EXECUTION_HOST_ID,
        SSH_HOST_ID
      ]),
      patch,
      setSync: vi.fn()
    },
    patch
  }
}

function sshCalls(patch: ReturnType<typeof vi.fn>): unknown[] {
  return patch.mock.calls.filter(([, hostId]) => hostId === SSH_HOST_ID).map(([args]) => args)
}

describe('clearing a sleeping-record field a non-local partition held', () => {
  it('sends the empty field to the ssh partition the last record left', async () => {
    const { api, patch } = makeApi()
    await patchWorkspaceSessionByHost(api, withRecord, catalog)
    await patchWorkspaceSessionByHost(api, cleared, catalog)
    await vi.waitFor(() => expect(sshCalls(patch)).toEqual([withRecord, cleared]))
  })

  it('never clears a partition this writer did not fill', async () => {
    const { api, patch } = makeApi()
    await patchWorkspaceSessionByHost(api, cleared, catalog)
    expect(sshCalls(patch)).toEqual([])
  })

  it('stops clearing once the clear lands', async () => {
    const { api, patch } = makeApi()
    await patchWorkspaceSessionByHost(api, withRecord, catalog)
    await patchWorkspaceSessionByHost(api, cleared, catalog)
    await vi.waitFor(() => expect(sshCalls(patch)).toHaveLength(2))
    await patchWorkspaceSessionByHost(api, cleared, catalog)
    await Promise.resolve()
    expect(sshCalls(patch)).toHaveLength(2)
  })

  it('EP-ERRORS: retries a clear whose partition write failed', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const patch = vi
      .fn()
      .mockResolvedValueOnce(undefined) // local
      .mockResolvedValueOnce(undefined) // ssh rows
      .mockResolvedValueOnce(undefined) // local
      .mockRejectedValueOnce(new Error('relay down')) // ssh clear
      .mockResolvedValue(undefined)
    const { api } = makeApi(patch)
    await patchWorkspaceSessionByHost(api, withRecord, catalog)
    await patchWorkspaceSessionByHost(api, cleared, catalog)
    await vi.waitFor(() => expect(warn).toHaveBeenCalled())
    await patchWorkspaceSessionByHost(api, cleared, catalog)
    expect(sshCalls(patch)).toEqual([withRecord, cleared, cleared])
    warn.mockRestore()
  })

  it('EP-STATE: an older clear settling late does not retire a host a newer write refilled', async () => {
    let settleClear: () => void = () => {}
    const patch = vi.fn((_args: unknown, hostId?: string) =>
      hostId === SSH_HOST_ID && patch.mock.calls.length === 4
        ? new Promise<void>((resolve) => {
            settleClear = resolve
          })
        : Promise.resolve()
    )
    const { api } = makeApi(patch)
    await patchWorkspaceSessionByHost(api, withRecord, catalog)
    await patchWorkspaceSessionByHost(api, cleared, catalog) // clear stays in flight
    await patchWorkspaceSessionByHost(api, withRecord, catalog) // refills the partition
    settleClear()
    await Promise.resolve()
    await patchWorkspaceSessionByHost(api, cleared, catalog)
    expect(sshCalls(patch)).toEqual([withRecord, cleared, withRecord, cleared])
  })
})

describe('clearing a partition the read found rows in', () => {
  it('clears an ssh partition whose restored record retired before any patch filled it', async () => {
    const { api, patch } = makeReadApi()
    await fetchWorkspaceSessionWithRuntimeHostOwners(api, [])
    await patchWorkspaceSessionByHost(api, cleared, catalog)
    await vi.waitFor(() => expect(sshCalls(patch)).toEqual([cleared]))
  })

  it('clears a host the full snapshot routes no rows to', async () => {
    const { api } = makeReadApi()
    await fetchWorkspaceSessionWithRuntimeHostOwners(api, [])
    const snapshots = buildWorkspaceSessionHostSnapshots(
      api,
      { ...getDefaultWorkspaceSession(), ...cleared },
      catalog
    )
    expect(
      snapshots.find((snapshot) => snapshot.hostId === SSH_HOST_ID)?.state
        .sleepingAgentSessionsByPaneKey
    ).toEqual({})
  })
})
