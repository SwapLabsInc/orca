// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useAppStore } from '../../store'
import { GeneralUpdateSettingsSection } from './GeneralUpdateSettingsSection'

vi.mock('./GeneralRemoteServerUpdates', () => ({ GeneralRemoteServerUpdates: () => null }))
vi.mock('./ReleaseChannelSection', () => ({ ReleaseChannelSection: () => null }))

const listSources = vi.fn()

beforeEach(() => {
  listSources.mockReset().mockResolvedValue([])
  useAppStore.setState({
    updateStatus: { state: 'available', version: '1.4.200', changelog: null }
  })
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      updater: {
        check: vi.fn(),
        download: vi.fn(),
        listSources,
        getVersion: vi.fn().mockResolvedValue('1.4.199')
      }
    }
  })
})

afterEach(() => {
  cleanup()
  useAppStore.setState({ updateStatus: { state: 'idle' } })
})

it('describes the available action as a download', () => {
  render(<GeneralUpdateSettingsSection />)

  expect(screen.getByRole('button', { name: 'Download Update (1.4.200)' })).toBeTruthy()
  expect(screen.getByText(/is available\. Click "Download Update" to download it\./)).toBeTruthy()
  expect(screen.queryByText(/download and install it/)).toBeNull()
})

// Why: an upstream build configures one source, so the per-source row, its badge and the
// source list read must all stay absent — today's markup, nothing more.
it('renders only the single-source row for a single-source build', async () => {
  render(<GeneralUpdateSettingsSection />)

  expect(await screen.findByText('Current version: 1.4.199')).toBeTruthy()
  expect(screen.getAllByRole('button')).toHaveLength(2)
  expect(screen.queryByText('Current source')).toBeNull()
  expect(screen.queryByRole('button', { name: /\(Orca upstream\)/ })).toBeNull()
  expect(listSources).not.toHaveBeenCalled()
})

it('links the refused build from an error that names a manual install page', () => {
  useAppStore.setState({
    updateStatus: {
      state: 'error',
      message: 'Orca on Windows only installs updates signed by the running build’s publisher.',
      userInitiated: true,
      manualInstallUrl: 'https://github.com/stablyai/orca/releases/tag/v1.4.200'
    }
  })
  render(<GeneralUpdateSettingsSection />)

  expect(screen.getByText(/Update check failed\. Orca on Windows/)).toBeTruthy()
  expect(screen.getByRole('link', { name: 'Open download page' }).getAttribute('href')).toBe(
    'https://github.com/stablyai/orca/releases/tag/v1.4.200'
  )
})
