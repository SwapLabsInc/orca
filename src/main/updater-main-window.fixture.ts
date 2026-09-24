import type { BrowserWindow } from 'electron'
import { vi, type Mock } from 'vitest'

/** Test-only: the one surface the updater touches on its main window is `webContents.send`. */
export function createUpdaterMainWindowFake(): {
  mainWindow: BrowserWindow
  send: Mock<(channel: string, payload: unknown) => void>
} {
  const send = vi.fn<(channel: string, payload: unknown) => void>()
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the updater reads nothing but webContents.send off its main window, and every suite asserts through this spy.
  const mainWindow = { webContents: { send } } as unknown as BrowserWindow
  return { mainWindow, send }
}
