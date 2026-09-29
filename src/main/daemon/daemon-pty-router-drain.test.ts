import { describe, expect, it, vi } from 'vitest'
import { DaemonPtyRouter } from './daemon-pty-router'
import { SessionNotFoundError, TerminalSessionOwnerUnverifiedError } from './daemon-errors'
import type { DaemonPtyAdapter } from './daemon-pty-adapter'
import type { PtySpawnOptions, PtySpawnResult } from '../providers/types'
import { PROTOCOL_VERSION } from './daemon-protocol-version'

// Only what routing a spawn touches: spawning, and the inventory that settles ownership.
function createAdapter(label: string, sessions: string[] = [], draining = false): DaemonPtyAdapter {
  return {
    protocolVersion: PROTOCOL_VERSION,
    draining,
    spawn: vi.fn(async (opts: PtySpawnOptions): Promise<PtySpawnResult> => {
      const id = opts.sessionId ?? `${label}-new`
      sessions.push(id)
      return { id }
    }),
    listProcesses: vi.fn(async () => sessions.map((id) => ({ id, cwd: '', title: label }))),
    onData: vi.fn(() => () => {}),
    onExit: vi.fn(() => () => {})
  } as unknown as DaemonPtyAdapter
}

describe('DaemonPtyRouter with a drained daemon', () => {
  it('only attaches to a drained daemon, which refuses to create', async () => {
    const current = createAdapter('current')
    const drained = createAdapter('drained', ['kept'], true)
    const router = new DaemonPtyRouter({ current, legacy: [drained] })
    await router.discoverLegacySessions()

    await router.spawn({ sessionId: 'kept', cols: 80, rows: 24 })

    expect(drained.spawn).toHaveBeenCalledExactlyOnceWith({
      sessionId: 'kept',
      attachOnly: true,
      cols: 80,
      rows: 24
    })
    expect(current.spawn).not.toHaveBeenCalled()
  })

  it('creates on the current daemon once a drained daemon no longer holds the session', async () => {
    const current = createAdapter('current')
    const drainedSessions = ['ended']
    const drained = createAdapter('drained', drainedSessions, true)
    const router = new DaemonPtyRouter({ current, legacy: [drained] })
    await router.discoverLegacySessions()
    drainedSessions.length = 0
    vi.mocked(drained.spawn).mockRejectedValueOnce(new SessionNotFoundError('ended'))

    await router.spawn({ sessionId: 'ended', cols: 80, rows: 24 })

    expect(current.spawn).toHaveBeenCalledExactlyOnceWith({
      sessionId: 'ended',
      cols: 80,
      rows: 24
    })
  })

  it('never creates beside a drained daemon whose ownership cannot be settled', async () => {
    const current = createAdapter('current')
    const drained = createAdapter('drained', ['kept'], true)
    const router = new DaemonPtyRouter({ current, legacy: [drained] })
    await router.discoverLegacySessions()
    vi.mocked(drained.spawn).mockRejectedValueOnce(new SessionNotFoundError('kept'))
    vi.mocked(drained.listProcesses).mockRejectedValue(new Error('wedged'))

    await expect(router.spawn({ sessionId: 'kept', cols: 80, rows: 24 })).rejects.toBeInstanceOf(
      TerminalSessionOwnerUnverifiedError
    )
    expect(current.spawn).not.toHaveBeenCalled()
  })

  it('still creates a session no daemon holds on the current one', async () => {
    const current = createAdapter('current')
    const drained = createAdapter('drained', ['kept'], true)
    const router = new DaemonPtyRouter({ current, legacy: [drained] })
    await router.discoverLegacySessions()

    await router.spawn({ sessionId: 'fresh', cols: 80, rows: 24 })

    expect(current.spawn).toHaveBeenCalledOnce()
    expect(drained.spawn).not.toHaveBeenCalled()
  })
})
