// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RemoteServerUpdateEntry } from '@/runtime/remote-server-update-coordinator'
import type { RemoteServerUpdateSupport } from '../../../../shared/remote-server-update'
import {
  getRemoteServerManualUpdateHelp,
  RemoteServerManualUpdateHelpLink
} from './RemoteServerUpdateStatus'

const HELP_URL = 'https://example.com/runbooks/orca-update'
const SERVICE_MANAGER_HELP =
  'Update Orca on the server host — through its system package manager if it was installed from a .deb or .rpm, otherwise through the service manager that starts it.'

const manual: RemoteServerUpdateSupport = {
  installMode: 'unsupported-headless-serve',
  automatic: false,
  reason: 'manual-service-update-required'
}

function entry(support: RemoteServerUpdateSupport | null): RemoteServerUpdateEntry {
  return {
    environmentId: 'server-a',
    name: 'Test server A',
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
}

const openUrl = vi.fn(async () => undefined)

beforeEach(() => {
  openUrl.mockClear()
  Object.defineProperty(window, 'api', { configurable: true, value: { shell: { openUrl } } })
})

afterEach(() => {
  cleanup()
  Object.defineProperty(window, 'api', { configurable: true, value: undefined })
})

describe('getRemoteServerManualUpdateHelp', () => {
  it('says the deployment manages updates when the host published a link', () => {
    expect(getRemoteServerManualUpdateHelp(entry({ ...manual, helpUrl: HELP_URL }))).toBe(
      'Updates for this server are managed by its deployment.'
    )
  })

  it('keeps the existing text for every host that published no link', () => {
    expect(getRemoteServerManualUpdateHelp(entry(manual))).toBe(SERVICE_MANAGER_HELP)
    expect(
      getRemoteServerManualUpdateHelp(
        entry({ installMode: 'interactive', automatic: false, reason: 'unpackaged-build' })
      )
    ).toBe('Development builds must be updated from their source checkout.')
    expect(getRemoteServerManualUpdateHelp(entry(null))).toBe(
      'Update this server manually once to enable remote updates.'
    )
  })

  it('keeps the existing text when the reason is not the deployment, link or no link', () => {
    expect(
      getRemoteServerManualUpdateHelp(
        entry({
          installMode: 'interactive',
          automatic: false,
          reason: 'unpackaged-build',
          helpUrl: HELP_URL
        })
      )
    ).toBe('Development builds must be updated from their source checkout.')
  })
})

describe('RemoteServerManualUpdateHelpLink', () => {
  it('opens the link in the external browser, never in the app window', () => {
    const before = window.location.href
    render(<RemoteServerManualUpdateHelpLink entry={entry({ ...manual, helpUrl: HELP_URL })} />)

    const link = screen.getByRole('button', { name: 'How to update' })
    expect(link.closest('a')).toBeNull()
    fireEvent.click(link)

    expect(openUrl).toHaveBeenCalledExactlyOnceWith(HELP_URL)
    expect(window.location.href).toBe(before)
  })

  it('renders nothing for a host that published no link', () => {
    const { container } = render(<RemoteServerManualUpdateHelpLink entry={entry(manual)} />)

    expect(container.innerHTML).toBe('')
  })

  it('renders nothing when the reason is not the deployment', () => {
    const { container } = render(
      <RemoteServerManualUpdateHelpLink
        entry={entry({
          installMode: 'interactive',
          automatic: false,
          reason: 'unpackaged-build',
          helpUrl: HELP_URL
        })}
      />
    )

    expect(container.innerHTML).toBe('')
  })
})
