// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { PublicKnownRuntimeEnvironment } from '../../../../shared/runtime-environments'
import type { RemoteServerUpdateSupport } from '../../../../shared/remote-server-update'
import type { RemoteServerUpdateEntry } from '@/runtime/remote-server-update-coordinator'
import { useAppStore } from '@/store'
import { RuntimeServerRow } from './runtime-server-row'

const HELP_URL = 'https://example.com/runbooks/orca-update'
const SERVICE_MANAGER_HELP =
  'Update Orca on the server host — through its system package manager if it was installed from a .deb or .rpm, otherwise through the service manager that starts it.'
const initialState = useAppStore.getInitialState()

const environment: PublicKnownRuntimeEnvironment = {
  id: 'env-a',
  name: 'Dev VM',
  createdAt: 100,
  updatedAt: 100,
  pairingRevision: 1,
  lastUsedAt: null,
  runtimeId: null,
  endpoints: [{ id: 'ws-a', kind: 'websocket', label: 'WebSocket', endpoint: 'ws://x' }],
  preferredEndpointId: 'ws-a'
}

const manual: RemoteServerUpdateSupport = {
  installMode: 'unsupported-headless-serve',
  automatic: false,
  reason: 'manual-service-update-required'
}

const openUrl = vi.fn(async () => undefined)

function renderRow(support: RemoteServerUpdateSupport): HTMLElement {
  const remoteUpdate: RemoteServerUpdateEntry = {
    environmentId: environment.id,
    name: environment.name,
    phase: 'manual',
    currentVersion: '1.4.0',
    targetVersion: null,
    progress: null,
    runtimeId: 'runtime-a',
    liveTabCount: 0,
    liveLeafCount: 0,
    support,
    error: null
  }
  return render(
    <RuntimeServerRow
      environment={environment}
      details={undefined}
      isActive={false}
      remoteUpdate={remoteUpdate}
      remoteServerUpdatesRunning={false}
      connecting={false}
      switching={false}
      disconnecting={false}
      removing={false}
      isBusy={false}
      onOpenUpdate={vi.fn()}
      onDisconnect={vi.fn()}
      onConnect={vi.fn()}
      onRemove={vi.fn()}
    />
  ).container
}

beforeEach(() => {
  useAppStore.setState(initialState, true)
  openUrl.mockClear()
  Object.defineProperty(window, 'api', { configurable: true, value: { shell: { openUrl } } })
})

afterEach(() => {
  cleanup()
  Object.defineProperty(window, 'api', { configurable: true, value: undefined })
})

it('shows the managed text and an external link for a host that published one', () => {
  renderRow({ ...manual, helpUrl: HELP_URL })

  const link = screen.getByRole('button', { name: 'How to update' })
  expect(link.parentElement?.textContent).toBe(
    'Updates for this server are managed by its deployment. How to update'
  )
  fireEvent.click(link)
  expect(openUrl).toHaveBeenCalledExactlyOnceWith(HELP_URL)
})

it('renders exactly the existing help for a host that published no link', () => {
  renderRow(manual)

  const help = screen.getByText(SERVICE_MANAGER_HELP)
  expect(help.tagName).toBe('P')
  expect(help.innerHTML).toBe(SERVICE_MANAGER_HELP)
  expect(screen.queryByRole('button', { name: 'How to update' })).toBeNull()
  expect(openUrl).not.toHaveBeenCalled()
})
