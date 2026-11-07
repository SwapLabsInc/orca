import { describe, it, expect } from 'vitest'
import {
  splitWorkspaceSessionByHost,
  mergeWorkspaceSessionsFromHosts,
  type HostIdByWorktreeId,
  type HostSessionSlices
} from './workspace-session-host-split'
import { getDefaultWorkspaceSession } from '../../../../../shared/constants'
import {
  LOCAL_EXECUTION_HOST_ID,
  toSshExecutionHostId,
  type ExecutionHostId
} from '../../../../../shared/execution-host'
import type { SleepingAgentSessionRecord } from '../../../../../shared/agent-session/lifecycle/agent-session-resume'
import type { WorkspaceSessionState } from '../../../../../shared/workspace-session/workspace-session-state-types'

const RUNTIME_A: ExecutionHostId = 'runtime:env-a'
const RUNTIME_B: ExecutionHostId = 'runtime:env-b'

const SSH_TARGET_ID = 'ssh-1788980107277-d9gffw'
/** A record's own stamp only names a host when some loaded id space claims it; production always
 *  passes these, and without them a stamp is unprovable and stays local. */
const HYDRATED_ORIGINS = {
  runtimeEnvironmentIds: new Set<string>(),
  sshTargetIds: new Set([SSH_TARGET_ID])
}
const SSH_HOST_ID: ExecutionHostId = toSshExecutionHostId(SSH_TARGET_ID)

function makeSleepingRecord(
  paneKey: string,
  worktreeId: string,
  connectionId?: string | null
): SleepingAgentSessionRecord {
  return {
    paneKey,
    worktreeId,
    agent: 'claude',
    providerSession: { key: 'session_id', id: `provider-${paneKey}` },
    prompt: 'p',
    state: 'done',
    capturedAt: 1,
    updatedAt: 2,
    ...(connectionId === undefined ? {} : { connectionId })
  }
}

/** worktree id convention in these tests: `<host>-wt-...`, except local ones. */
function ownerByPrefix(): HostIdByWorktreeId {
  return (worktreeId: string) => {
    if (worktreeId.startsWith('a-')) {
      return RUNTIME_A
    }
    if (worktreeId.startsWith('b-')) {
      return RUNTIME_B
    }
    return LOCAL_EXECUTION_HOST_ID
  }
}

describe('splitWorkspaceSessionByHost', () => {
  it('routes a sleeping record by its own ssh connection when its worktree has no row', () => {
    const state: WorkspaceSessionState = {
      ...getDefaultWorkspaceSession(),
      sleepingAgentSessionsByPaneKey: {
        'pane-ssh': makeSleepingRecord('pane-ssh', 'unknown-wt', SSH_TARGET_ID)
      }
    }

    const slices = splitWorkspaceSessionByHost(state, ownerByPrefix(), {
      sleepingRecordOrigins: HYDRATED_ORIGINS
    })

    expect(slices[SSH_HOST_ID]?.sleepingAgentSessionsByPaneKey).toHaveProperty('pane-ssh')
    expect(slices[LOCAL_EXECUTION_HOST_ID]?.sleepingAgentSessionsByPaneKey).toEqual({})
  })

  it('keeps an ssh-stamped record local while no id space can prove the stamp', () => {
    const state: WorkspaceSessionState = {
      ...getDefaultWorkspaceSession(),
      sleepingAgentSessionsByPaneKey: {
        'pane-ssh': makeSleepingRecord('pane-ssh', 'unknown-wt', SSH_TARGET_ID)
      }
    }

    const slices = splitWorkspaceSessionByHost(state, ownerByPrefix(), {
      sleepingRecordOrigins: { runtimeEnvironmentIds: new Set(), sshTargetIds: null }
    })

    expect(slices[LOCAL_EXECUTION_HOST_ID]?.sleepingAgentSessionsByPaneKey).toHaveProperty(
      'pane-ssh'
    )
    expect(slices[SSH_HOST_ID]).toBeUndefined()
  })

  it('keeps a sleeping record put when its connectionId names no host', () => {
    const state: WorkspaceSessionState = {
      ...getDefaultWorkspaceSession(),
      sleepingAgentSessionsByPaneKey: {
        'pane-null': makeSleepingRecord('pane-null', 'unknown-wt', null),
        'pane-unstamped': makeSleepingRecord('pane-unstamped', 'unknown-wt')
      }
    }

    const slices = splitWorkspaceSessionByHost(state, ownerByPrefix())

    const local = slices[LOCAL_EXECUTION_HOST_ID]?.sleepingAgentSessionsByPaneKey ?? {}
    expect(Object.keys(local)).toEqual(['pane-null', 'pane-unstamped'])
    expect(slices[SSH_HOST_ID]).toBeUndefined()
  })

  it('leaves a sleeping record whose worktree routes to a host on that host', () => {
    const state: WorkspaceSessionState = {
      ...getDefaultWorkspaceSession(),
      sleepingAgentSessionsByPaneKey: {
        'pane-a': makeSleepingRecord('pane-a', 'a-wt', SSH_TARGET_ID)
      }
    }

    const slices = splitWorkspaceSessionByHost(state, ownerByPrefix())

    expect(slices[RUNTIME_A]?.sleepingAgentSessionsByPaneKey).toHaveProperty('pane-a')
    expect(slices[SSH_HOST_ID]).toBeUndefined()
  })

  it('round trips old-shape sleeping rows already sitting in the local partition', () => {
    // An old profile: the ssh-origin row was written into 'local' and the ssh partition has none.
    const persisted: HostSessionSlices = {
      [LOCAL_EXECUTION_HOST_ID]: {
        ...getDefaultWorkspaceSession(),
        sleepingAgentSessionsByPaneKey: {
          'pane-ssh': makeSleepingRecord('pane-ssh', 'unknown-wt', SSH_TARGET_ID),
          'pane-local': makeSleepingRecord('pane-local', 'local-wt')
        }
      },
      [SSH_HOST_ID]: { ...getDefaultWorkspaceSession(), sleepingAgentSessionsByPaneKey: {} }
    }

    const merged = mergeWorkspaceSessionsFromHosts(persisted)
    expect(Object.keys(merged.sleepingAgentSessionsByPaneKey ?? {}).sort()).toEqual([
      'pane-local',
      'pane-ssh'
    ])

    const slices = splitWorkspaceSessionByHost(merged, ownerByPrefix(), {
      sleepingRecordOrigins: HYDRATED_ORIGINS
    })
    expect(slices[SSH_HOST_ID]?.sleepingAgentSessionsByPaneKey).toHaveProperty('pane-ssh')
    expect(slices[LOCAL_EXECUTION_HOST_ID]?.sleepingAgentSessionsByPaneKey).toHaveProperty(
      'pane-local'
    )
    expect(mergeWorkspaceSessionsFromHosts(slices).sleepingAgentSessionsByPaneKey).toEqual(
      merged.sleepingAgentSessionsByPaneKey
    )
  })
})
