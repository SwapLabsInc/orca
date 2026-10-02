import { afterEach, describe, expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import { OrchestrationDb } from '../../../../orchestration/db'
import { createOrchestrationWorkerReleaseHarness } from './worker-release.test-support'
import {
  awaitReleaseClosingTurn,
  WORKER_RELEASE_CLOSING_TURN_CUT_OFF_WARNING,
  WORKER_RELEASE_CLOSING_TURN_TIMEOUT_MS
} from './worker-release-closing-turn'

type WaitResult = Awaited<ReturnType<OrcaRuntimeService['waitForTerminal']>>

const IDLE: WaitResult = {
  handle: 'term_worker',
  condition: 'tui-idle',
  satisfied: true,
  status: 'running',
  exitCode: null
}

function readWarnings(value: unknown): unknown[] | null {
  return typeof value === 'object' && value !== null && 'warnings' in value
    ? Array.isArray(value.warnings)
      ? value.warnings
      : null
    : null
}

function archiveWarnings(
  h: ReturnType<typeof createOrchestrationWorkerReleaseHarness>,
  id: string
) {
  const archive = h.db.getWorkerTerminalArchive(id)
  return archive ? readWarnings(JSON.parse(archive.content)) : null
}

describe('worker release waits for the closing turn', () => {
  const h = createOrchestrationWorkerReleaseHarness()

  afterEach(() => h.cleanup())

  it('freezes output and closes the tab only after the turn that sent worker_done ends', async () => {
    h.setup()
    const { dispatchId } = await h.startSettledWorker()
    const turn = h.deferred<WaitResult>()
    vi.mocked(h.runtime.waitForTerminal).mockReset().mockReturnValue(turn.promise)

    const release = h.call('orchestration.workerRelease', { dispatch: dispatchId })
    await vi.waitFor(() =>
      expect(h.runtime.waitForTerminal).toHaveBeenCalledWith('term_worker', {
        condition: 'tui-idle',
        timeoutMs: WORKER_RELEASE_CLOSING_TURN_TIMEOUT_MS
      })
    )
    expect(h.runtime.readTerminal).not.toHaveBeenCalled()
    expect(h.runtime.closeTerminal).not.toHaveBeenCalled()

    turn.resolve(IDLE)

    await expect(release).resolves.toMatchObject({ state: 'released' })
    expect(h.runtime.closeTerminal).toHaveBeenCalledTimes(1)
    expect(archiveWarnings(h, dispatchId)).not.toContain(
      WORKER_RELEASE_CLOSING_TURN_CUT_OFF_WARNING
    )
  })

  it('still releases at the bound, and the archive says the closing turn was cut off', async () => {
    h.setup()
    const { dispatchId } = await h.startSettledWorker()
    vi.mocked(h.runtime.waitForTerminal).mockReset().mockRejectedValue(new Error('timeout'))

    await expect(
      h.call('orchestration.workerRelease', { dispatch: dispatchId })
    ).resolves.toMatchObject({ state: 'released' })

    expect(h.runtime.closeTerminal).toHaveBeenCalledTimes(1)
    expect(archiveWarnings(h, dispatchId)).toContain(WORKER_RELEASE_CLOSING_TURN_CUT_OFF_WARNING)
    const read = await h.call('orchestration.workerRead', { dispatch: dispatchId })
    expect(readWarnings(read)).toContain(WORKER_RELEASE_CLOSING_TURN_CUT_OFF_WARNING)
  })

  it('lets an explicit retain during the wait keep the terminal and its tab', async () => {
    h.setup()
    const { dispatchId } = await h.startSettledWorker()
    const turn = h.deferred<WaitResult>()
    vi.mocked(h.runtime.waitForTerminal).mockReset().mockReturnValue(turn.promise)

    const release = h.call('orchestration.workerRelease', { dispatch: dispatchId })
    await vi.waitFor(() => expect(h.runtime.waitForTerminal).toHaveBeenCalledTimes(1))
    await expect(
      h.call('orchestration.workerRetain', { dispatch: dispatchId })
    ).resolves.toMatchObject({ state: 'retained', reason: 'user_requested' })
    turn.resolve(IDLE)

    await expect(release).resolves.toMatchObject({ state: 'retained', reason: 'user_requested' })
    expect(h.runtime.closeTerminal).not.toHaveBeenCalled()
    expect(h.db.getWorkerTerminalArchive(dispatchId)).toBeUndefined()
  })

  it('treats a closing turn parked on a human-only prompt as cut off', async () => {
    h.setup()
    const { dispatchId } = await h.startSettledWorker()
    vi.mocked(h.runtime.waitForTerminal)
      .mockReset()
      .mockResolvedValue({ ...IDLE, satisfied: false, blockedReason: 'codex-interactive-prompt' })

    await expect(
      h.call('orchestration.workerRelease', { dispatch: dispatchId })
    ).resolves.toMatchObject({ state: 'released' })

    expect(archiveWarnings(h, dispatchId)).toContain(WORKER_RELEASE_CLOSING_TURN_CUT_OFF_WARNING)
  })

  it('still waits when the archive store cannot be read, leaving that failure to the release', async () => {
    const db = new OrchestrationDb(':memory:')
    db.db.exec('DROP TABLE worker_terminal_archives')
    const runtime = {
      isTerminalRunningAgent: vi.fn().mockResolvedValue(true),
      waitForTerminal: vi.fn().mockResolvedValue(IDLE)
    }
    try {
      await expect(
        awaitReleaseClosingTurn({ runtime, db, dispatchId: 'ctx_store_down' }, 'term_worker')
      ).resolves.toBe('settled')
      expect(runtime.waitForTerminal).toHaveBeenCalledTimes(1)
    } finally {
      db.close()
    }
  })

  it('does not wait on a terminal that is not running an agent', async () => {
    h.setup()
    const { dispatchId } = await h.startSettledWorker()
    vi.mocked(h.runtime.isTerminalRunningAgent).mockResolvedValue(false)
    vi.mocked(h.runtime.waitForTerminal).mockClear()

    await expect(
      h.call('orchestration.workerRelease', { dispatch: dispatchId })
    ).resolves.toMatchObject({ state: 'released' })

    expect(h.runtime.waitForTerminal).not.toHaveBeenCalled()
    expect(archiveWarnings(h, dispatchId)).not.toContain(
      WORKER_RELEASE_CLOSING_TURN_CUT_OFF_WARNING
    )
  })
})
