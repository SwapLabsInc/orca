import { app, type BrowserWindow } from 'electron'
import { isHiddenHelperContents } from '../../browser/hidden-helper-window'

function scheduleAfterFirstWindowShown(task: () => void, fallbackMs: number | null): void {
  let ran = false
  const run = (): void => {
    if (ran) {
      return
    }
    ran = true
    if (fallback) {
      clearTimeout(fallback)
    }
    // Yield so the window paints first; catch deferred failures because uncaughtException is fatal outside the readiness chain.
    setImmediate(() => {
      try {
        task()
      } catch (error) {
        console.warn('[startup] deferred first-window task failed', error)
      }
    })
  }
  const fallback = fallbackMs === null ? null : setTimeout(run, fallbackMs)
  fallback?.unref?.()
  const waitForAppWindow = (): void => {
    app.once('browser-window-created', (_event: Electron.Event, window: BrowserWindow) => {
      // A hidden helper (such as a launch cookie restore's) is not the first app window.
      if (isHiddenHelperContents(window.webContents)) {
        waitForAppWindow()
        return
      }
      window.once('ready-to-show', run)
    })
  }
  waitForAppWindow()
}

/** Defer noncritical disk/probe work until first paint; fallback handles headless serve and GPU failures that never emit ready-to-show. */
export function runAfterFirstWindowShown(task: () => void, fallbackMs: number): void {
  scheduleAfterFirstWindowShown(task, fallbackMs)
}

/**
 * LOCAL: run `task` once the first window can paint, and never otherwise. For work that vouches
 * for the window (the self-update health marker): a fallback timer would run it for a renderer
 * that hung or crashed before `ready-to-show`, and headless serve, which opens no window, must not
 * run it at all.
 */
export function runOnlyAfterFirstWindowShown(task: () => void): void {
  scheduleAfterFirstWindowShown(task, null)
}
