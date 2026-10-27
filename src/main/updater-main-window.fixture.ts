import type { BrowserWindow } from 'electron'
import { vi, type Mock } from 'vitest'
import { updaterMainWindow } from './updater-test-main-window'

/** Test-only: upstream's updater window fake, with its `webContents.send` spy handed back. */
export function createUpdaterMainWindowFake(): {
  mainWindow: BrowserWindow
  send: Mock<(channel: string, payload: unknown) => void>
} {
  const send = vi.fn<(channel: string, payload: unknown) => void>()
  return { mainWindow: updaterMainWindow(send), send }
}
