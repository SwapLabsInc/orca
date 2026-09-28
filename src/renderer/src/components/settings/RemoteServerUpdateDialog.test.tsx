// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RemoteServerUpdateEntry } from '@/runtime/remote-server-update-coordinator'
import { RemoteServerUpdateDialog } from './RemoteServerUpdateDialog'

const currentEntry: RemoteServerUpdateEntry = {
  environmentId: 'server-a',
  name: 'Test server A',
  phase: 'current',
  currentVersion: '1.4.150-rc.0',
  targetVersion: null,
  progress: null,
  runtimeId: 'runtime-a',
  liveTabCount: 0,
  liveLeafCount: 0,
  support: null,
  error: null
}

const storeMock = vi.hoisted(() => ({
  state: {
    remoteServerUpdateDialogOpen: true,
    remoteServerUpdates: new Map<string, RemoteServerUpdateEntry>(),
    remoteServerUpdatesChecking: false,
    remoteServerUpdatesRunning: false,
    setRemoteServerUpdateDialogOpen: vi.fn(),
    refreshRemoteServerUpdates: vi.fn(async () => {}),
    startRemoteServerUpdates: vi.fn(async () => {})
  }
}))

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: typeof storeMock.state) => unknown) => selector(storeMock.state)
}))

vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ open, children }: { open: boolean; children: React.ReactNode }) =>
    open ? <div>{children}</div> : null,
  DialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogDescription: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <div>{children}</div>
}))

describe('RemoteServerUpdateDialog', () => {
  beforeEach(() => {
    storeMock.state.remoteServerUpdates = new Map([[currentEntry.environmentId, currentEntry]])
    storeMock.state.remoteServerUpdatesChecking = false
    storeMock.state.remoteServerUpdatesRunning = false
    storeMock.state.refreshRemoteServerUpdates.mockClear()
    storeMock.state.startRemoteServerUpdates.mockClear()
  })

  it('checks on open and only shows an update action when one is available', async () => {
    const container = document.createElement('div')
    const root = createRoot(container)

    await act(async () => root.render(<RemoteServerUpdateDialog />))

    expect(storeMock.state.refreshRemoteServerUpdates).toHaveBeenCalledOnce()
    expect(container.textContent).toContain('All servers are up to date.')
    expect(container.textContent).not.toContain('Check for Server Updates')
    expect(container.textContent).not.toContain('Update server')

    await act(async () => root.unmount())
  })

  it('shows the update action after a check finds an available server', async () => {
    storeMock.state.remoteServerUpdates = new Map([
      [
        currentEntry.environmentId,
        { ...currentEntry, phase: 'available', targetVersion: '1.4.151' }
      ]
    ])
    const container = document.createElement('div')
    const root = createRoot(container)

    await act(async () => root.render(<RemoteServerUpdateDialog />))

    expect(container.textContent).not.toContain('Check for Server Updates')
    expect(container.textContent).toContain('Update this server')
    expect(container.textContent).not.toContain('Update all')

    await act(async () => root.unmount())
  })

  it('offers an explicit batch action when multiple servers can update', async () => {
    const secondEntry: RemoteServerUpdateEntry = {
      ...currentEntry,
      environmentId: 'server-b',
      name: 'Test server B'
    }
    storeMock.state.remoteServerUpdates = new Map([
      [
        currentEntry.environmentId,
        { ...currentEntry, phase: 'available', targetVersion: '1.4.151' }
      ],
      [secondEntry.environmentId, { ...secondEntry, phase: 'available', targetVersion: '1.4.151' }]
    ])
    const container = document.createElement('div')
    const root = createRoot(container)

    await act(async () => root.render(<RemoteServerUpdateDialog />))

    const labels = [...container.querySelectorAll('button')].map((button) => button.textContent)
    expect(labels.filter((label) => label === 'Update this server')).toHaveLength(2)
    expect(labels).toContain('Update all 2 servers')

    await act(async () => root.unmount())
  })

  it('links a managed server to its update instructions in the external browser', async () => {
    const openUrl = vi.fn(async () => undefined)
    Object.defineProperty(window, 'api', { configurable: true, value: { shell: { openUrl } } })
    storeMock.state.remoteServerUpdates = new Map([
      [
        currentEntry.environmentId,
        {
          ...currentEntry,
          phase: 'manual',
          support: {
            installMode: 'unsupported-headless-serve',
            automatic: false,
            reason: 'manual-service-update-required',
            helpUrl: 'https://example.com/runbooks/orca-update'
          }
        }
      ]
    ])
    const container = document.createElement('div')
    const root = createRoot(container)

    await act(async () => root.render(<RemoteServerUpdateDialog />))

    const link = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === 'How to update'
    )
    expect(link?.parentElement?.textContent).toBe(
      'Updates for this server are managed by its deployment. How to update'
    )
    await act(async () => link?.click())
    expect(openUrl).toHaveBeenCalledExactlyOnceWith('https://example.com/runbooks/orca-update')

    await act(async () => root.unmount())
    Object.defineProperty(window, 'api', { configurable: true, value: undefined })
  })

  it('renders exactly the existing help for a manual server that published no link', async () => {
    storeMock.state.remoteServerUpdates = new Map([
      [
        currentEntry.environmentId,
        {
          ...currentEntry,
          phase: 'manual',
          support: {
            installMode: 'unsupported-headless-serve',
            automatic: false,
            reason: 'manual-service-update-required'
          }
        }
      ]
    ])
    const container = document.createElement('div')
    const root = createRoot(container)

    await act(async () => root.render(<RemoteServerUpdateDialog />))

    const help = [...container.querySelectorAll('p')].find((paragraph) =>
      paragraph.textContent.startsWith('Update Orca on the server host')
    )
    expect(help?.innerHTML).toBe(
      'Update Orca on the server host — through its system package manager if it was installed from a .deb or .rpm, otherwise through the service manager that starts it.'
    )
    expect(container.textContent).not.toContain('How to update')

    await act(async () => root.unmount())
  })
})
