import type { OrchestrationDb } from '../../../../orchestration/db'
import { awaitReleaseClosingTurn, type WorkerClosingTurn } from './worker-release-closing-turn'

type ClosingTurnRuntime = Parameters<typeof awaitReleaseClosingTurn>[0]['runtime']

/** Only an interactive release waits out the worker's closing turn, so only it needs a runtime that can. */
export type ClosingTurnMode =
  | { mode: 'recovery' }
  | { mode?: 'interactive'; runtime: ClosingTurnRuntime }

export async function awaitClosingTurnForMode(
  args: ClosingTurnMode & { db: OrchestrationDb; dispatchId: string },
  terminalHandle: string | null
): Promise<WorkerClosingTurn> {
  if (args.mode === 'recovery') {
    return 'not_observed'
  }
  return awaitReleaseClosingTurn(args, terminalHandle)
}
