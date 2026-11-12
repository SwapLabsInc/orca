import type { OrcaRuntimeService } from '../../../../orca-runtime'
import type { OrchestrationDb } from '../../../../orchestration/db/orchestration-db'
import type { RemoteDispatchAttachmentRow } from '../../../../orchestration/db/orchestration-records'
import type { WorkerTerminalArchiveRow } from '../../../../orchestration/terminal-authority/release/worker-terminal-ownership'
import type { WorkerOutputArchiveCapture } from '../../../../orchestration/workers/archives/worker-output-archive'
import { isStructuredWorkerHandle } from '../../../../../../shared/orchestration/workers/structured-worker-handle'

/** Fits the 30 s a coordinator gives a federated release (and the CLI's 60 s) beside capture and stop. */
export const WORKER_RELEASE_CLOSING_TURN_TIMEOUT_MS = 15_000

export const WORKER_RELEASE_CLOSING_TURN_CUT_OFF_WARNING =
  'The worker was still finishing the turn that sent worker_done when it was released; its closing message may be missing.'

/** `cut_off` is the only outcome that proves the agent was still mid-turn at release. */
export type WorkerClosingTurn = 'settled' | 'cut_off' | 'not_observed'

type ClosingTurnRuntime = Pick<OrcaRuntimeService, 'isTerminalRunningAgent' | 'waitForTerminal'>

// Why: worker_done is a tool call inside the agent's last turn, so a coordinator that releases on
// receipt SIGTERMs the closing message mid-write and freezes an archive without it.
export async function awaitWorkerClosingTurn(
  runtime: ClosingTurnRuntime,
  terminalHandle: string,
  timeoutMs = WORKER_RELEASE_CLOSING_TURN_TIMEOUT_MS
): Promise<WorkerClosingTurn> {
  // Why: a bare shell never reports agent idle, so waiting on it would only add the full bound.
  const runningAgent = await runtime.isTerminalRunningAgent(terminalHandle).catch(() => false)
  if (!runningAgent) {
    return 'not_observed'
  }
  try {
    const result = await runtime.waitForTerminal(terminalHandle, {
      condition: 'tui-idle',
      timeoutMs
    })
    // Idle and exit end the turn; a prompt only a human can answer ends the wait but not the turn.
    return result.satisfied ? 'settled' : 'cut_off'
  } catch (error) {
    // A stale or vanished handle is the identity checks' to judge; it is not a cut-off turn.
    return error instanceof Error && error.message === 'timeout' ? 'cut_off' : 'not_observed'
  }
}

export function awaitReleaseClosingTurn(
  args: {
    runtime: ClosingTurnRuntime
    db: OrchestrationDb
    dispatchId: string
    mode?: 'interactive' | 'recovery'
  },
  terminalHandle: string | null
): Promise<WorkerClosingTurn> {
  // Recovery must not stall startup; a stored archive or a structured worker leaves no turn to wait on.
  if (
    !terminalHandle ||
    args.mode === 'recovery' ||
    isStructuredWorkerHandle(terminalHandle) ||
    hasStoredArchive(args.db, args.dispatchId)
  ) {
    return Promise.resolve('not_observed')
  }
  return awaitWorkerClosingTurn(args.runtime, terminalHandle)
}

/** A federated release waits where the worker runs, before that host observes the attachment. */
export function awaitFederatedClosingTurn(
  runtime: ClosingTurnRuntime & Pick<OrcaRuntimeService, 'getOrchestrationDb'>,
  dispatchId: string,
  attachment: Pick<RemoteDispatchAttachmentRow, 'stage' | 'terminal_handle'>
): Promise<WorkerClosingTurn> {
  return awaitReleaseClosingTurn(
    { runtime, db: runtime.getOrchestrationDb(), dispatchId },
    attachment.stage === 'released' ? null : attachment.terminal_handle
  )
}

// An unreadable store still gets the wait; reporting the read failure stays with the release.
function hasStoredArchive(db: OrchestrationDb, dispatchId: string): boolean {
  try {
    return Boolean(db.getWorkerTerminalArchive(dispatchId))
  } catch {
    return false
  }
}

/** A fork field on upstream's reference row; a reader that does not know it ignores it. */
type CutOffOutputReference = WorkerOutputArchiveCapture['content'] & { closingTurnCutOff: true }

export function noteClosingTurnInArchive(
  capture: WorkerOutputArchiveCapture,
  closingTurn: WorkerClosingTurn
): WorkerOutputArchiveCapture {
  // Only a transcript is read after release; a chat worker is never waited on.
  if (closingTurn !== 'cut_off' || capture.kind !== 'transcript_pin') {
    return capture
  }
  const content: CutOffOutputReference = { ...capture.content, closingTurnCutOff: true }
  return { ...capture, content }
}

/** A released worker's output, warning when its release cut the closing turn off. */
export function withClosingTurnWarning<T extends { warnings: string[] }>(
  archive: Pick<WorkerTerminalArchiveRow, 'content'>,
  output: T
): T {
  return releaseCutOffClosingTurn(archive.content)
    ? { ...output, warnings: [...output.warnings, WORKER_RELEASE_CLOSING_TURN_CUT_OFF_WARNING] }
    : output
}

function releaseCutOffClosingTurn(content: string): boolean {
  try {
    const reference: unknown = JSON.parse(content)
    return (
      typeof reference === 'object' &&
      reference !== null &&
      'closingTurnCutOff' in reference &&
      reference.closingTurnCutOff === true
    )
  } catch {
    return false
  }
}
