import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runAfterFirstWindowShown, runOnlyAfterFirstWindowShown } from './first-window-deferral'

/** The one `app` event the deferral listens for, delivered to whoever asked for it once. */
const electronApp = vi.hoisted(() => {
  type WindowCreatedListener = (event: unknown, window: unknown) => void
  const listeners: WindowCreatedListener[] = []
  return {
    once(_event: string, listener: WindowCreatedListener): void {
      listeners.push(listener)
    },
    createWindow(window: unknown): void {
      for (const listener of listeners.splice(0)) {
        listener({}, window)
      }
    }
  }
})

vi.mock('electron', () => ({ app: electronApp }))

describe('first window deferral', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('runs the task once, after the first window can show or after the fallback', async () => {
    const task = vi.fn()
    runAfterFirstWindowShown(task, 20_000)
    const window = new EventEmitter()
    electronApp.createWindow(window)
    window.emit('ready-to-show')
    await vi.advanceTimersByTimeAsync(0)
    expect(task).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(20_000)
    expect(task).toHaveBeenCalledTimes(1)

    const fallbackTask = vi.fn()
    runAfterFirstWindowShown(fallbackTask, 20_000)
    // Why past the deadline: the fake clock skips an unref'd timer due exactly at the tick's end.
    await vi.advanceTimersByTimeAsync(20_001)
    expect(fallbackTask).toHaveBeenCalledTimes(1)
  })

  // LOCAL: the self-update helper keeps whatever build writes the health marker. A renderer that
  // hangs or crashes before `ready-to-show` used to be certified by the 20 s fallback, so the
  // helper kept an unusable build and its rollback was pruned.
  it('never runs a window-only task on a timer, only once the window can show', async () => {
    const task = vi.fn()
    runOnlyAfterFirstWindowShown(task)
    const window = new EventEmitter()
    electronApp.createWindow(window)

    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(task).not.toHaveBeenCalled()

    window.emit('ready-to-show')
    await vi.advanceTimersByTimeAsync(0)
    expect(task).toHaveBeenCalledTimes(1)
    window.emit('ready-to-show')
    await vi.advanceTimersByTimeAsync(0)
    expect(task).toHaveBeenCalledTimes(1)
  })

  it('never runs a window-only task when no window is created at all', async () => {
    const task = vi.fn()
    runOnlyAfterFirstWindowShown(task)

    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(task).not.toHaveBeenCalled()
  })
})
