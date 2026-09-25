import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { IpcMainInvokeEvent } from 'electron'
import type { Store } from '../persistence'
import type { ReleaseSourceStatus } from '../../shared/update-status-types'

type InvokeHandler = (event: Partial<IpcMainInvokeEvent>, ...args: unknown[]) => unknown

const { handleMock, removeHandlerMock, listReleaseSourcesMock } = vi.hoisted(() => ({
  handleMock: vi.fn<(channel: string, handler: InvokeHandler) => void>(),
  removeHandlerMock: vi.fn(),
  listReleaseSourcesMock: vi.fn()
}))

vi.mock('electron', () => ({
  app: { getVersion: vi.fn(() => '1.4.197-swaplabs.202609251710') },
  clipboard: {},
  systemPreferences: { askForMediaAccess: vi.fn(), getMediaAccessStatus: vi.fn() },
  ipcMain: {
    on: vi.fn(),
    removeAllListeners: vi.fn(),
    removeListener: vi.fn(),
    removeHandler: removeHandlerMock,
    handle: handleMock
  },
  powerMonitor: { on: vi.fn(), off: vi.fn() }
}))

vi.mock('../ipc/repos', () => ({ registerRepoHandlers: vi.fn() }))
vi.mock('../ipc/worktrees', () => ({ registerWorktreeHandlers: vi.fn() }))
vi.mock('../ipc/worktree-change-invalidators', () => ({ runWorktreeChangeInvalidators: vi.fn() }))
vi.mock('../ipc/pty', () => ({ getLocalPtyProvider: vi.fn(), registerPtyHandlers: vi.fn() }))
vi.mock('../memory/hydrate-local-pty-registry', () => ({
  hydrateLocalPtyRegistryAtBoot: vi.fn()
}))
vi.mock('../browser/browser-manager', () => ({ browserManager: { unregisterAll: vi.fn() } }))
vi.mock('../macos-tcc-prompt-notice', () => ({
  acknowledgePendingTccPromptNotice: vi.fn(),
  consumePendingTccPromptNotice: vi.fn(),
  dismissTccPromptNotice: vi.fn(),
  releasePendingTccPromptNotice: vi.fn()
}))

vi.mock('../updater', () => ({
  checkForUpdates: vi.fn(),
  checkForUpdatesFromMenu: vi.fn(),
  downloadUpdate: vi.fn(),
  getUpdateStatus: vi.fn(),
  quitAndInstall: vi.fn(),
  dismissNudge: vi.fn(),
  dismissAvailableUpdate: vi.fn(),
  setupAutoUpdater: vi.fn(),
  getLinuxPackageInstallInstructions: vi.fn(),
  showLinuxPackage: vi.fn(),
  listAvailableReleaseBuilds: vi.fn(),
  listReleaseSources: listReleaseSourcesMock
}))

import { registerUpdaterHandlers } from './attach-main-window-services'

const SOURCE_ROWS: ReleaseSourceStatus[] = [
  {
    id: 'upstream',
    label: 'Orca upstream',
    running: false,
    install: 'in-app',
    latest: null,
    error: 'GitHub rate limit reached. Try again in about a minute.'
  },
  {
    id: 'swaplabs',
    label: 'SwapLabs',
    running: true,
    install: 'in-app',
    latest: null,
    error: null
  }
]

function getHandler(): InvokeHandler {
  const registration = handleMock.mock.calls.find(([channel]) => channel === 'updater:listSources')
  if (!registration) {
    throw new Error('updater:listSources handler was not registered')
  }
  return registration[1]
}

describe('updater:listSources IPC', () => {
  beforeAll(() => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the updater handlers never read the store argument.
    registerUpdaterHandlers({} as Store)
  })

  beforeEach(() => {
    listReleaseSourcesMock.mockReset().mockResolvedValue(SOURCE_ROWS)
  })

  it('re-registers the handler so a second window attach cannot double-register', () => {
    expect(removeHandlerMock).toHaveBeenCalledWith('updater:listSources')
    expect(
      handleMock.mock.calls.filter(([channel]) => channel === 'updater:listSources')
    ).toHaveLength(1)
  })

  // Why: per-source failures travel as data inside the rows, so the invoke itself resolves.
  it('returns the rows main produced, list failures included', async () => {
    await expect(getHandler()({})).resolves.toEqual(SOURCE_ROWS)
    expect(listReleaseSourcesMock).toHaveBeenCalledWith({ force: false })
  })

  it('forces a fresh list only for an explicit force flag', async () => {
    await getHandler()({}, { force: true })
    expect(listReleaseSourcesMock).toHaveBeenLastCalledWith({ force: true })

    await getHandler()({}, { force: 'yes' })
    expect(listReleaseSourcesMock).toHaveBeenLastCalledWith({ force: false })
  })
})
