/**
 * A sleeping record's `connectionId` is a host STAMP, not a host kind.
 *
 * A paired-runtime status captured during a catalog gap carries the runtime environment id
 * (web-session-tabs-sync/agent-status-patch.ts) and quit capture copies it onto the record, so
 * reading every nonempty value as an ssh target files the pane's only resume handle under
 * `ssh:<environmentId>` — a partition no runtime reader ever opens, which is exactly the lost
 * handle this feature exists to prevent.
 */
import { describe, expect, it } from 'vitest'
import { getDefaultWorkspaceSession } from '../../../shared/constants'
import {
  LOCAL_EXECUTION_HOST_ID,
  toRuntimeExecutionHostId,
  toSshExecutionHostId,
  type ExecutionHostId
} from '../../../shared/execution-host'
import type { SleepingAgentSessionRecord } from '../../../shared/agent-session-resume'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import type { SleepingRecordOriginHosts } from './sleeping-record-origin-host'
import {
  buildHostSessionRouting,
  type HostPersistenceState
} from './workspace-session-host-persistence'
import { splitWorkspaceSessionByHost } from './workspace-session-host-split'

const RUNTIME_ENVIRONMENT_ID = 'env-mini-1'
const RUNTIME_HOST_ID: ExecutionHostId = toRuntimeExecutionHostId(RUNTIME_ENVIRONMENT_ID)
const SSH_TARGET_ID = 'ssh-1788980107277-d9gffw'
const SSH_HOST_ID: ExecutionHostId = toSshExecutionHostId(SSH_TARGET_ID)

function makeRecord(paneKey: string, connectionId: string): SleepingAgentSessionRecord {
  return {
    paneKey,
    worktreeId: 'unrouted-wt',
    agent: 'claude',
    providerSession: { key: 'session_id', id: `provider-${paneKey}` },
    prompt: 'p',
    state: 'done',
    capturedAt: 1,
    updatedAt: 2,
    connectionId
  }
}

function sessionWith(records: Record<string, SleepingAgentSessionRecord>): WorkspaceSessionState {
  return { ...getDefaultWorkspaceSession(), sleepingAgentSessionsByPaneKey: records }
}

function split(
  state: WorkspaceSessionState,
  sleepingRecordOrigins: SleepingRecordOriginHosts
): ReturnType<typeof splitWorkspaceSessionByHost> {
  // Every worktree here is one the catalog has no row for, so routing answers 'local' and the
  // record's own stamp is the only remaining evidence.
  return splitWorkspaceSessionByHost(state, () => LOCAL_EXECUTION_HOST_ID, {
    sleepingRecordOrigins
  })
}

describe('sleeping-record origin host, by id space', () => {
  it('routes a runtime-stamped record to its runtime partition, never ssh:<environmentId>', () => {
    const slices = split(
      sessionWith({ 'pane-rt': makeRecord('pane-rt', RUNTIME_ENVIRONMENT_ID) }),
      {
        runtimeEnvironmentIds: new Set([RUNTIME_ENVIRONMENT_ID]),
        sshTargetIds: new Set([SSH_TARGET_ID])
      }
    )

    expect(slices[RUNTIME_HOST_ID]?.sleepingAgentSessionsByPaneKey).toHaveProperty('pane-rt')
    expect(slices[toSshExecutionHostId(RUNTIME_ENVIRONMENT_ID)]).toBeUndefined()
  })

  it('still routes a known ssh target to its ssh partition', () => {
    const slices = split(sessionWith({ 'pane-ssh': makeRecord('pane-ssh', SSH_TARGET_ID) }), {
      runtimeEnvironmentIds: new Set([RUNTIME_ENVIRONMENT_ID]),
      sshTargetIds: new Set([SSH_TARGET_ID])
    })

    expect(slices[SSH_HOST_ID]?.sleepingAgentSessionsByPaneKey).toHaveProperty('pane-ssh')
    expect(slices[LOCAL_EXECUTION_HOST_ID]?.sleepingAgentSessionsByPaneKey).toEqual({})
  })

  it('keeps an id neither space claims in the local partition instead of guessing ssh', () => {
    const slices = split(sessionWith({ 'pane-x': makeRecord('pane-x', 'who-knows') }), {
      runtimeEnvironmentIds: new Set([RUNTIME_ENVIRONMENT_ID]),
      sshTargetIds: new Set([SSH_TARGET_ID])
    })

    expect(slices[LOCAL_EXECUTION_HOST_ID]?.sleepingAgentSessionsByPaneKey).toHaveProperty('pane-x')
    expect(slices[toSshExecutionHostId('who-knows')]).toBeUndefined()
  })

  it('keeps a runtime-stamped record local when the environment catalog has not landed', () => {
    // The catalog-gap capture: the stamp IS a runtime environment id, but neither list can say so
    // yet. `ssh:<environmentId>` is a partition no reader opens, so the guess is unrecoverable.
    const slices = split(
      sessionWith({ 'pane-rt': makeRecord('pane-rt', RUNTIME_ENVIRONMENT_ID) }),
      {
        runtimeEnvironmentIds: new Set(),
        sshTargetIds: null
      }
    )

    expect(slices[LOCAL_EXECUTION_HOST_ID]?.sleepingAgentSessionsByPaneKey).toHaveProperty(
      'pane-rt'
    )
    expect(slices[toSshExecutionHostId(RUNTIME_ENVIRONMENT_ID)]).toBeUndefined()
  })

  it('keeps a record local when its runtime environment was removed from the catalog', () => {
    const slices = split(
      sessionWith({ 'pane-rt': makeRecord('pane-rt', RUNTIME_ENVIRONMENT_ID) }),
      {
        runtimeEnvironmentIds: new Set(['env-other']),
        sshTargetIds: null
      }
    )

    expect(slices[LOCAL_EXECUTION_HOST_ID]?.sleepingAgentSessionsByPaneKey).toHaveProperty(
      'pane-rt'
    )
    expect(slices[toSshExecutionHostId(RUNTIME_ENVIRONMENT_ID)]).toBeUndefined()
  })

  it('keeps an unhydrated ssh target list local rather than guessing a partition', () => {
    // An unhydrated list cannot tell an ssh target apart from a runtime environment id, so the two
    // cases above are this same call. Local is the recoverable placement: every reader loads it and
    // `adoptStrandedHostPartitionSession` returns the row to its partition once a list can prove it.
    const slices = split(sessionWith({ 'pane-ssh': makeRecord('pane-ssh', SSH_TARGET_ID) }), {
      runtimeEnvironmentIds: new Set(),
      sshTargetIds: null
    })

    expect(slices[LOCAL_EXECUTION_HOST_ID]?.sleepingAgentSessionsByPaneKey).toHaveProperty(
      'pane-ssh'
    )
    expect(slices[SSH_HOST_ID]).toBeUndefined()
  })
})

describe('buildHostSessionRouting sleeping-record origins', () => {
  const baseState: HostPersistenceState = {
    repos: [],
    worktreesByRepo: {}
  }

  it('names a runtime environment the catalog holds, and the hydrated ssh target set', () => {
    const routing = buildHostSessionRouting({
      ...baseState,
      runtimeEnvironments: [{ id: RUNTIME_ENVIRONMENT_ID }],
      sshTargetLabels: new Map([[SSH_TARGET_ID, 'mini']]),
      sshTargetsHydrated: true
    })

    expect(routing.sleepingRecordOrigins.runtimeEnvironmentIds.has(RUNTIME_ENVIRONMENT_ID)).toBe(
      true
    )
    expect(routing.sleepingRecordOrigins.sshTargetIds?.has(SSH_TARGET_ID)).toBe(true)
  })

  it('reads a runtime environment out of restored ownership when the catalog has not landed', () => {
    const routing = buildHostSessionRouting({
      ...baseState,
      restoredRuntimeHostIdByWorkspaceSessionKey: { 'repo::wt': RUNTIME_HOST_ID }
    })

    expect(routing.sleepingRecordOrigins.runtimeEnvironmentIds.has(RUNTIME_ENVIRONMENT_ID)).toBe(
      true
    )
    expect(routing.sleepingRecordOrigins.sshTargetIds).toBeNull()
  })

  it('end to end: a runtime-stamped record reaches the runtime partition', () => {
    const routing = buildHostSessionRouting({
      ...baseState,
      runtimeEnvironments: [{ id: RUNTIME_ENVIRONMENT_ID }],
      sshTargetsHydrated: true
    })
    const slices = splitWorkspaceSessionByHost(
      sessionWith({ 'pane-rt': makeRecord('pane-rt', RUNTIME_ENVIRONMENT_ID) }),
      routing.hostIdByWorktreeId,
      { sleepingRecordOrigins: routing.sleepingRecordOrigins }
    )

    expect(slices[RUNTIME_HOST_ID]?.sleepingAgentSessionsByPaneKey).toHaveProperty('pane-rt')
  })
})
