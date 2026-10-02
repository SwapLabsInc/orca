import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ORCHESTRATION_CONTRACT_VERSION } from '../../../../../../shared/protocol-version'
import { OrcaRuntimeService } from '../../../../orca-runtime'
import { OrchestrationDb } from '../../../../orchestration/db'
import { ORCHESTRATION_METHODS } from '../../orchestration'
import { eraseRpcMethods } from '../../../core'
import {
  WORKER_RELEASE_CLOSING_TURN_CUT_OFF_WARNING,
  WORKER_RELEASE_CLOSING_TURN_TIMEOUT_MS
} from '../worker/worker-release-closing-turn'

const HOME_FINGERPRINT = 'home-peer'
const PANE_KEY = 'tab_remote:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const PROCESS_INCARNATION = 'runtime:pty:7'
const TERMINAL_HANDLE = 'term_remote'
const DISPATCH_ID = 'ctx_remote'

type WaitResult = Awaited<ReturnType<OrcaRuntimeService['waitForTerminal']>>

function readWarnings(value: unknown): unknown[] | null {
  return typeof value === 'object' && value !== null && 'warnings' in value
    ? Array.isArray(value.warnings)
      ? value.warnings
      : null
    : null
}

describe('federated worker release waits for the closing turn', () => {
  let db: OrchestrationDb
  let runtime: OrcaRuntimeService

  beforeEach(() => {
    db = new OrchestrationDb(':memory:')
    runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
    vi.spyOn(runtime, 'getTerminalPaneKey').mockReturnValue(PANE_KEY)
    vi.spyOn(runtime, 'getTerminalProcessIncarnation').mockReturnValue(PROCESS_INCARNATION)
    vi.spyOn(runtime, 'showTerminal').mockResolvedValue({
      handle: TERMINAL_HANDLE,
      ptyId: null,
      worktreeId: 'repo::remote',
      worktreePath: '/remote/repo',
      branch: 'main',
      tabId: 'tab_remote',
      leafId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      title: null,
      connected: true,
      writable: true,
      lastOutputAt: null,
      preview: '',
      paneRuntimeId: -1,
      rendererGraphEpoch: 0
    })
    vi.spyOn(runtime, 'getTerminalLivenessVerdict').mockReturnValue({
      status: 'live',
      ptyIds: [TERMINAL_HANDLE]
    })
    vi.spyOn(runtime, 'getExactWorkerProviderSession').mockReturnValue(null)
    vi.spyOn(runtime, 'readTerminal').mockResolvedValue({
      handle: TERMINAL_HANDLE,
      status: 'running',
      tail: ['closing summary'],
      truncated: false,
      nextCursor: '1'
    })
    vi.spyOn(runtime, 'isTerminalRunningAgent').mockResolvedValue(true)
    vi.spyOn(runtime, 'closeTerminal').mockResolvedValue({
      handle: TERMINAL_HANDLE,
      tabId: 'tab-remote',
      ptyKilled: true
    })
    createSettledAttachment()
  })

  afterEach(() => {
    db.close()
    vi.restoreAllMocks()
  })

  it('captures and closes on the execution host only after the turn ends', async () => {
    let endTurn!: (result: WaitResult) => void
    vi.spyOn(runtime, 'waitForTerminal').mockReturnValue(
      new Promise<WaitResult>((resolve) => {
        endTurn = resolve
      })
    )

    const release = call('orchestration.federationRelease')
    await vi.waitFor(() =>
      expect(runtime.waitForTerminal).toHaveBeenCalledWith(TERMINAL_HANDLE, {
        condition: 'tui-idle',
        timeoutMs: WORKER_RELEASE_CLOSING_TURN_TIMEOUT_MS
      })
    )
    expect(runtime.readTerminal).not.toHaveBeenCalled()
    expect(runtime.closeTerminal).not.toHaveBeenCalled()

    endTurn({
      handle: TERMINAL_HANDLE,
      condition: 'tui-idle',
      satisfied: true,
      status: 'running',
      exitCode: null
    })

    await expect(release).resolves.toMatchObject({ state: 'released' })
    expect(runtime.closeTerminal).toHaveBeenCalledTimes(1)
  })

  it('still releases at the bound and records the cut-off turn in the archive', async () => {
    vi.spyOn(runtime, 'waitForTerminal').mockRejectedValue(new Error('timeout'))

    await expect(call('orchestration.federationRelease')).resolves.toMatchObject({
      state: 'released'
    })

    const archive = db.getWorkerTerminalArchive(DISPATCH_ID)
    expect(archive ? readWarnings(JSON.parse(archive.content)) : null).toContain(
      WORKER_RELEASE_CLOSING_TURN_CUT_OFF_WARNING
    )
    expect(runtime.closeTerminal).toHaveBeenCalledTimes(1)
  })

  function createSettledAttachment(): void {
    db.createRemoteDispatchAttachment({
      runId: 'run-home',
      dispatchId: DISPATCH_ID,
      taskId: `task_${DISPATCH_ID}`,
      homePeerFingerprint: HOME_FINGERPRINT,
      protocolVersion: ORCHESTRATION_CONTRACT_VERSION,
      runtimeEpoch: runtime.getRuntimeId(),
      mutationReceipt: {
        callerFingerprint: HOME_FINGERPRINT,
        requestId: `request_${DISPATCH_ID}`,
        method: 'orchestration.federationAttachStart',
        payloadHash: `hash_${DISPATCH_ID}`
      }
    })
    db.prepareRemoteAttachmentAuthority({
      dispatchId: DISPATCH_ID,
      paneKey: PANE_KEY,
      processIncarnation: PROCESS_INCARNATION,
      worktreeId: 'repo::remote',
      terminalHandle: TERMINAL_HANDLE,
      setupState: 'not_applicable',
      effects: [{ kind: 'terminal', action: 'created', id: TERMINAL_HANDLE }],
      terminalOwnership: 'created'
    })
    db.markRemoteAttachmentReady(DISPATCH_ID)
    db.recordRemoteAttachmentStage({
      dispatchId: DISPATCH_ID,
      state: 'succeeded',
      stage: 'worker_reported'
    })
  }

  async function call(name: string): Promise<unknown> {
    const method = eraseRpcMethods(ORCHESTRATION_METHODS).find(
      (candidate) => candidate.name === name
    )
    if (!method) {
      throw new Error(`Method not found: ${name}`)
    }
    return method.handler(method.params!.parse({ dispatchId: DISPATCH_ID }), {
      runtime,
      authenticatedCallerFingerprint: HOME_FINGERPRINT
    })
  }
})
