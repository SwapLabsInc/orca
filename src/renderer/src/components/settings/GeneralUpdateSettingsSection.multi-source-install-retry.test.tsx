// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useAppStore } from '../../store'
import { GeneralUpdateSettingsSection } from './GeneralUpdateSettingsSection'

vi.mock('./GeneralRemoteServerUpdates', () => ({ GeneralRemoteServerUpdates: () => null }))
vi.mock('./ReleaseChannelSection', () => ({ ReleaseChannelSection: () => null }))

// Why hoisted: the source registry reads the define once, when the component's imports load.
const { sources } = await vi.hoisted(async () => {
  const sources = await import('../../../../shared/release-sources.fixture')
  sources.setReleaseSourcesLiteralForTest(sources.FORK_RELEASE_SOURCES_LITERAL)
  return { sources }
})

const STAGED_VERSION = '1.4.197-swaplabs.202609260900'
const quitAndInstall = vi.fn()

beforeEach(() => {
  quitAndInstall.mockReset().mockResolvedValue(undefined)
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      updater: {
        check: vi.fn(),
        download: vi.fn(),
        quitAndInstall,
        listSources: vi.fn().mockResolvedValue([]),
        getVersion: vi.fn().mockResolvedValue('1.4.197-swaplabs.202609251710')
      },
      shell: { openUrl: vi.fn() }
    }
  })
})

afterEach(() => {
  cleanup()
  useAppStore.setState({ updateStatus: { state: 'idle' } })
})

afterAll(() => {
  sources.setReleaseSourcesLiteralForTest(null)
})

// LOCAL: the multi-source row must offer the staged-install retry and blocker guidance too.
it('retries a blocked staged install from the multi-source row', () => {
  useAppStore.setState({
    updateStatus: {
      state: 'error',
      version: STAGED_VERSION,
      retryAction: 'install',
      message: 'Raw process listing',
      installBlock: { reason: 'running-instances', instances: [{ pid: 42, kind: 'server' }] }
    }
  })
  render(<GeneralUpdateSettingsSection />)

  expect(screen.getByText(/Stop the server from the terminal/)).toBeTruthy()
  expect(screen.queryByText(/Raw process listing/)).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Try Again' }))
  expect(quitAndInstall).toHaveBeenCalledOnce()
})

it('disables the multi-source restart button during preparation', () => {
  useAppStore.setState({
    updateStatus: { state: 'downloaded', version: STAGED_VERSION, installing: true }
  })
  render(<GeneralUpdateSettingsSection />)

  const button = screen.getByRole('button', { name: `Restart to Update (${STAGED_VERSION})` })
  expect(button.hasAttribute('disabled')).toBe(true)
})
