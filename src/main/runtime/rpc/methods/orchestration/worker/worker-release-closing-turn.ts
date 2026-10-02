import type { OrcaRuntimeService } from '../../../../orca-runtime'
import type { OrchestrationDb } from '../../../../orchestration/db'
import type { WorkerOutputArchiveCapture } from '../../../../orchestration/worker-output-archive'
import { isStructuredWorkerHandle } from '../../../../structured-worker-identity'

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
    // Idle, a human-only prompt, and exit all end the turn; waiting longer would add nothing.
    await runtime.waitForTerminal(terminalHandle, { condition: 'tui-idle', timeoutMs })
    return 'settled'
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

// An unreadable archive store is the release's to report, so it skips the wait rather than throw.
function hasStoredArchive(db: OrchestrationDb, dispatchId: string): boolean {
  try {
    return Boolean(db.getWorkerTerminalArchive(dispatchId))
  } catch {
    return true
  }
}

export function noteClosingTurnInArchive(
  capture: WorkerOutputArchiveCapture,
  closingTurn: WorkerClosingTurn
): WorkerOutputArchiveCapture {
  if (closingTurn !== 'cut_off') {
    return capture
  }
  const warning = WORKER_RELEASE_CLOSING_TURN_CUT_OFF_WARNING
  switch (capture.kind) {
    case 'transcript_pin':
      return {
        ...capture,
        content: { ...capture.content, warnings: [...capture.content.warnings, warning] }
      }
    case 'terminal_tail':
      return {
        ...capture,
        content: { ...capture.content, warnings: [...capture.content.warnings, warning] }
      }
    case 'structured_journal':
      return capture
  }
}
