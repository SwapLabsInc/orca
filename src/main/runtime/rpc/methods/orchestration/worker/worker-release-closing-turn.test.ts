import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from '../../../../orca-runtime'
import { OrchestrationDb } from '../../../../orchestration/db/orchestration-db'
import { createOrchestrationWorkerReleaseHarness } from './worker-release.test-support'
import {
  awaitReleaseClosingTurn,
  WORKER_RELEASE_CLOSING_TURN_CUT_OFF_WARNING,
  WORKER_RELEASE_CLOSING_TURN_TIMEOUT_MS
} from './worker-release-closing-turn'

// Resolve only the exact file, so worker-read never falls back to this machine's agent homes.
vi.mock('../../../../../native-chat/session-file-resolver', () => ({
  resolveSessionFilePath: async (
    _agent: string,
    _sessionId: string,
    options: { transcriptPath?: string }
  ) => options.transcriptPath ?? null
}))

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

describe('worker release waits for the closing turn', () => {
  const h = createOrchestrationWorkerReleaseHarness()
  let directory: string

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'orca-closing-turn-'))
  })

  afterEach(async () => {
    h.cleanup()
    await rm(directory, { recursive: true, force: true })
  })

  /** A released worker's output is read from its transcript, so the worker needs one. */
  async function giveWorkerTranscript(): Promise<void> {
    const transcriptPath = join(directory, 'rollout-worker.jsonl')
    const message = { id: 'm1', type: 'agent_message', message: 'closing summary' }
    await writeFile(
      transcriptPath,
      `${JSON.stringify({ timestamp: '2026-11-12T12:00:00.000Z', type: 'event_msg', payload: message })}\n`
    )
    vi.mocked(h.runtime.getExactWorkerProviderSession).mockReturnValue({
      paneKey: h.workerPaneKey,
      processIncarnation: 'pty:1',
      agent: 'codex',
      providerSession: { key: 'session_id', id: 'session-1', transcriptPath },
      observedAt: 1
    })
  }

  async function releasedReadWarnings(dispatchId: string): Promise<unknown[] | null> {
    return readWarnings(await h.call('orchestration.workerRead', { dispatch: dispatchId }))
  }

  it('closes the tab only after the turn that sent worker_done ends', async () => {
    h.setup()
    await giveWorkerTranscript()
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
    expect(h.runtime.closeTerminal).not.toHaveBeenCalled()

    turn.resolve(IDLE)

    await expect(release).resolves.toMatchObject({ state: 'released' })
    expect(h.runtime.closeTerminal).toHaveBeenCalledTimes(1)
    expect(await releasedReadWarnings(dispatchId)).not.toContain(
      WORKER_RELEASE_CLOSING_TURN_CUT_OFF_WARNING
    )
  })

  it('still releases at the bound, and worker-read says the closing turn was cut off', async () => {
    h.setup()
    await giveWorkerTranscript()
    const { dispatchId } = await h.startSettledWorker()
    vi.mocked(h.runtime.waitForTerminal).mockReset().mockRejectedValue(new Error('timeout'))

    await expect(
      h.call('orchestration.workerRelease', { dispatch: dispatchId })
    ).resolves.toMatchObject({ state: 'released' })

    expect(h.runtime.closeTerminal).toHaveBeenCalledTimes(1)
    expect(await releasedReadWarnings(dispatchId)).toContain(
      WORKER_RELEASE_CLOSING_TURN_CUT_OFF_WARNING
    )
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
    await giveWorkerTranscript()
    const { dispatchId } = await h.startSettledWorker()
    vi.mocked(h.runtime.waitForTerminal)
      .mockReset()
      .mockResolvedValue({ ...IDLE, satisfied: false, blockedReason: 'codex-interactive-prompt' })

    await expect(
      h.call('orchestration.workerRelease', { dispatch: dispatchId })
    ).resolves.toMatchObject({ state: 'released' })

    expect(await releasedReadWarnings(dispatchId)).toContain(
      WORKER_RELEASE_CLOSING_TURN_CUT_OFF_WARNING
    )
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
    await giveWorkerTranscript()
    const { dispatchId } = await h.startSettledWorker()
    vi.mocked(h.runtime.isTerminalRunningAgent).mockResolvedValue(false)
    vi.mocked(h.runtime.waitForTerminal).mockClear()

    await expect(
      h.call('orchestration.workerRelease', { dispatch: dispatchId })
    ).resolves.toMatchObject({ state: 'released' })

    expect(h.runtime.waitForTerminal).not.toHaveBeenCalled()
    expect(await releasedReadWarnings(dispatchId)).not.toContain(
      WORKER_RELEASE_CLOSING_TURN_CUT_OFF_WARNING
    )
  })
})
