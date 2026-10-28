import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  checkBoundMailbox,
  createBoundRun,
  createDatabase,
  createRuntime,
  driveToLiveIdle,
  insertDirectRunMessage,
  PTY_ID,
  temporaryDirectories
} from './orchestration-mailbox-notification-test-harness'
import {
  POINTER_TYPING_QUIET_MS,
  POINTER_UNSUBMITTED_DRAFT_HOLD_MS
} from './orchestration/mailbox-pointer-typing-hold'
import type { MessageType } from './orchestration/types'

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => tmpdir()), isPackaged: false },
  BrowserWindow: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  webContents: { fromId: vi.fn(() => null) }
}))

// The delivery recheck polls a held pane every 2s; allow one poll past each window.
const RECHECK_SLACK_MS = 2_500

async function idleCoordinator(prefix: string) {
  vi.useFakeTimers()
  const db = createDatabase(prefix)
  const { runtime, write } = createRuntime(db)
  const run = createBoundRun(db, 'Typing hold Run')
  await driveToLiveIdle(runtime)
  const arrive = (subject: string, type: MessageType = 'status') => {
    const message = insertDirectRunMessage(db, run.id, subject, type)
    runtime.notifyMessageArrived(`run:${run.id}`, type)
    return message
  }
  // Every client's keys reach the runtime through this record (desktop IPC, remote and mobile RPC).
  const type = (data: string, inputKind: 'driving' | 'launch' = 'driving') =>
    runtime.terminalRunFacts.recordInput(PTY_ID, inputKind, data)
  const writes = () => write.mock.calls.map(([, data]) => String(data))
  return { db, runtime, arrive, type, writes }
}

const pointer = (count: number) =>
  expect.stringContaining(`You have ${count} orchestration message${count === 1 ? '' : 's'}.`)

describe('mailbox pointer and the user typing to the agent', () => {
  afterEach(() => {
    vi.useRealTimers()
    for (const directory of temporaryDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('types nothing for heartbeats alone, and counts them in the next pointer as check does', async () => {
    const { db, runtime, arrive, writes } = await idleCoordinator('orca-heartbeat-only-pointer-')
    arrive('alive', 'heartbeat')
    arrive('still alive', 'heartbeat')
    await vi.advanceTimersByTimeAsync(10_000)
    expect(writes()).toEqual([])

    arrive('task finished')
    await vi.advanceTimersByTimeAsync(10_000)

    expect(writes()).toEqual([pointer(3), '\r'])
    expect((await checkBoundMailbox(runtime)).count).toBe(3)
    db.close()
  })

  it.each([
    ['sent', ' auth\r', POINTER_TYPING_QUIET_MS],
    ['left unsent until the draft bound', ' auth', POINTER_UNSUBMITTED_DRAFT_HOLD_MS]
  ])(
    'holds the pointer while the user types, then types it once: draft %s',
    async (_label, finish, heldForMs) => {
      const { db, arrive, type, writes } = await idleCoordinator('orca-typing-hold-pointer-')
      type('refactor the')
      arrive('task finished')
      await vi.advanceTimersByTimeAsync(POINTER_TYPING_QUIET_MS - 500)
      type(finish)
      await vi.advanceTimersByTimeAsync(heldForMs - 1_000)
      expect(writes()).toEqual([])

      await vi.advanceTimersByTimeAsync(1_000 + RECHECK_SLACK_MS)
      expect(writes()).toEqual([pointer(1), '\r'])
      await vi.advanceTimersByTimeAsync(POINTER_UNSUBMITTED_DRAFT_HOLD_MS)
      expect(writes()).toEqual([pointer(1), '\r'])
      db.close()
    }
  )

  it('leaves the pointer to the user, unsubmitted, when they type before its Enter', async () => {
    const { db, runtime, arrive, type, writes } = await idleCoordinator('orca-typing-enter-delay-')
    const message = arrive('task finished')
    await vi.advanceTimersByTimeAsync(100)
    expect(writes()).toEqual([pointer(1)])

    type('w')
    await vi.advanceTimersByTimeAsync(POINTER_UNSUBMITTED_DRAFT_HOLD_MS + RECHECK_SLACK_MS)

    expect(writes()).toEqual([pointer(1)])
    expect(db.getMessageById(message.id)).toMatchObject({ read: 0, pointer_enter_pending: 0 })
    expect(db.getMessageById(message.id)?.delivered_at).not.toBeNull()
    expect((await checkBoundMailbox(runtime)).count).toBe(1)
    db.close()
  })

  it('folds mail that arrives during a hold into the one pointer typed after it', async () => {
    const { db, runtime, arrive, type, writes } = await idleCoordinator('orca-typing-hold-merge-')
    type('a')
    arrive('first report')
    await vi.advanceTimersByTimeAsync(RECHECK_SLACK_MS)
    arrive('second report')
    type('nd go\r')
    await vi.advanceTimersByTimeAsync(POINTER_TYPING_QUIET_MS - 500)
    arrive('third report', 'heartbeat')
    expect(writes()).toEqual([])

    await vi.advanceTimersByTimeAsync(500 + RECHECK_SLACK_MS)
    arrive('fourth report', 'heartbeat')
    await vi.advanceTimersByTimeAsync(POINTER_UNSUBMITTED_DRAFT_HOLD_MS)

    expect(writes()).toEqual([pointer(3), '\r'])
    expect((await checkBoundMailbox(runtime)).count).toBe(4)
    db.close()
  })

  it('points mail parked behind a pointer the user typed into once they stop typing', async () => {
    const { db, arrive, type, writes } = await idleCoordinator('orca-typing-parked-redrive-')
    arrive('first report')
    await vi.advanceTimersByTimeAsync(100)
    arrive('second report')
    type('x')
    await vi.advanceTimersByTimeAsync(1_000)
    expect(writes()).toEqual([pointer(1)])

    type('\x15')
    await vi.advanceTimersByTimeAsync(POINTER_TYPING_QUIET_MS + RECHECK_SLACK_MS)
    await vi.advanceTimersByTimeAsync(POINTER_UNSUBMITTED_DRAFT_HOLD_MS)

    expect(writes()).toEqual([pointer(1), pointer(1), '\r'])
    db.close()
  })

  it.each([
    ['no client key reached the runtime', null],
    ["only Orca's launch writes did", 'launch'],
    ['the clock stepped back past the last key', 'clock']
  ] as const)('types the pointer at once when %s', async (_label, input) => {
    const { db, arrive, type, writes } = await idleCoordinator('orca-typing-signal-absent-')
    if (input === 'launch') {
      type('start here', 'launch')
    } else if (input === 'clock') {
      vi.setSystemTime(Date.now() + 60_000)
      type('typed before the step back')
      vi.setSystemTime(Date.now() - 60_000)
    }
    arrive('task finished')
    await vi.advanceTimersByTimeAsync(1_000)

    expect(writes()).toEqual([pointer(1), '\r'])
    db.close()
  })
})
