// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { ReleaseSourceStatus, UpdateStatus } from '../../../../shared/update-status-types'
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

const FORK_VERSION = '1.4.197-swaplabs.202609251710'
const NEWER_FORK_VERSION = '1.4.197-swaplabs.202609260900'
const UPSTREAM_BUILD = {
  tag: 'v1.4.198',
  version: '1.4.198',
  channel: 'stable',
  name: null,
  publishedAt: null,
  releaseUrl: 'https://github.com/stablyai/orca/releases/tag/v1.4.198',
  installerUrl: 'https://github.com/stablyai/orca/releases/download/v1.4.198/orca-linux.AppImage'
} as const
const FORK_BUILD = {
  tag: 'swaplabs-v1.4.197+202609251710',
  version: FORK_VERSION,
  channel: 'stable',
  name: `${FORK_VERSION} • main • abc1234`,
  publishedAt: null,
  releaseUrl: 'https://github.com/SwapLabsInc/orca/releases/tag/swaplabs-v1.4.197%2B202609251710',
  installerUrl:
    'https://github.com/SwapLabsInc/orca/releases/download/swaplabs-v1.4.197%2B202609251710/orca-linux.AppImage'
} as const

function sourceRows(overrides?: {
  upstream?: Partial<ReleaseSourceStatus>
  swaplabs?: Partial<ReleaseSourceStatus>
}): ReleaseSourceStatus[] {
  return [
    {
      id: 'upstream',
      label: 'Orca upstream',
      running: false,
      install: 'in-app',
      latest: UPSTREAM_BUILD,
      error: null,
      ...overrides?.upstream
    },
    {
      id: 'swaplabs',
      label: 'SwapLabs',
      running: true,
      install: 'in-app',
      latest: FORK_BUILD,
      error: null,
      ...overrides?.swaplabs
    }
  ]
}

const check = vi.fn()
const download = vi.fn()
const listSources = vi.fn()
const openUrl = vi.fn()

function setStatus(status: UpdateStatus): void {
  useAppStore.setState({ updateStatus: status })
}

beforeEach(() => {
  check.mockReset().mockResolvedValue(undefined)
  download.mockReset().mockResolvedValue(undefined)
  openUrl.mockReset().mockResolvedValue(undefined)
  listSources.mockReset().mockResolvedValue(sourceRows())
  setStatus({ state: 'idle' })
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      updater: {
        check,
        download,
        listSources,
        getVersion: vi.fn().mockResolvedValue(FORK_VERSION)
      },
      shell: { openUrl }
    }
  })
})

afterEach(() => {
  cleanup()
  setStatus({ state: 'idle' })
})

afterAll(() => {
  sources.setReleaseSourcesLiteralForTest(null)
})

const upstreamButton = (): HTMLButtonElement =>
  screen.getByRole<HTMLButtonElement>('button', { name: 'Download 1.4.198 (Orca upstream)' })
const forkButton = (name = `Download ${FORK_VERSION} (SwapLabs)`): HTMLButtonElement =>
  screen.getByRole<HTMLButtonElement>('button', { name })
const checkButton = (): HTMLButtonElement =>
  screen.getByRole<HTMLButtonElement>('button', { name: 'Check for Updates' })

it('renders one button per configured source with the running source marked', async () => {
  render(<GeneralUpdateSettingsSection />)

  await waitFor(() => expect(upstreamButton()).toBeTruthy())
  expect(screen.getByRole('button', { name: 'Check for Updates' })).toBeTruthy()
  expect(upstreamButton().disabled).toBe(false)
  // The running build is the newest SwapLabs build, so its own button has nothing to offer.
  expect(forkButton().disabled).toBe(true)
  expect(forkButton().getAttribute('title')).toBe('This is the build you are running.')
  expect(screen.getByText('Current source')).toBeTruthy()
  expect(screen.getByText(`Current version: ${FORK_VERSION} · SwapLabs`)).toBeTruthy()
  expect(
    screen.getByText('Updates are checked automatically on launch against the SwapLabs releases.')
  ).toBeTruthy()
  expect(screen.queryByRole('button', { name: /Download Update/ })).toBeNull()
  expect(listSources).toHaveBeenCalledWith(undefined)
})

it('starts a pinned auto-download for another source from its button', async () => {
  render(<GeneralUpdateSettingsSection />)

  await waitFor(() => expect(upstreamButton()).toBeTruthy())
  fireEvent.click(upstreamButton())

  expect(check).toHaveBeenCalledWith({
    channel: 'stable',
    targetTag: 'v1.4.198',
    source: 'upstream',
    targetVersion: '1.4.198',
    autoDownload: true
  })
  expect(download).not.toHaveBeenCalled()
  expect(openUrl).not.toHaveBeenCalled()
})

it('offers a newer build of the running source as the primary action', async () => {
  listSources.mockResolvedValue(
    sourceRows({ swaplabs: { latest: { ...FORK_BUILD, version: NEWER_FORK_VERSION } } })
  )
  render(<GeneralUpdateSettingsSection />)

  const button = await screen.findByRole<HTMLButtonElement>('button', {
    name: `Download ${NEWER_FORK_VERSION} (SwapLabs)`
  })
  expect(button.disabled).toBe(false)
  expect(button.getAttribute('data-variant')).toBe('default')
  expect(upstreamButton().getAttribute('data-variant')).toBe('secondary')
})

it('swaps Download for Open download page when the install is a manual installer', async () => {
  listSources.mockResolvedValue(sourceRows({ upstream: { install: 'manual-installer' } }))
  render(<GeneralUpdateSettingsSection />)

  const button = await screen.findByRole('button', { name: 'Open download page (Orca upstream)' })
  expect(button.getAttribute('title')).toBe('1.4.198')
  fireEvent.click(button)

  expect(openUrl).toHaveBeenCalledWith(UPSTREAM_BUILD.installerUrl)
  expect(check).not.toHaveBeenCalled()
})

it('opens the release page for an externally managed Linux package', async () => {
  listSources.mockResolvedValue(
    sourceRows({
      upstream: { install: 'externally-managed' },
      swaplabs: { install: 'externally-managed' }
    })
  )
  render(<GeneralUpdateSettingsSection />)

  fireEvent.click(await screen.findByRole('button', { name: 'Open download page (Orca upstream)' }))

  expect(openUrl).toHaveBeenCalledWith(UPSTREAM_BUILD.releaseUrl)
  expect(check).not.toHaveBeenCalled()
})

it('disables every source button while checking and downloading', async () => {
  render(<GeneralUpdateSettingsSection />)
  await waitFor(() => expect(upstreamButton()).toBeTruthy())

  setStatus({ state: 'checking', userInitiated: true, releaseSource: 'upstream' })
  await waitFor(() => expect(upstreamButton().disabled).toBe(true))
  expect(screen.getByText('Checking Orca upstream releases...')).toBeTruthy()

  setStatus({ state: 'downloading', percent: 42, version: '1.4.198', releaseSource: 'upstream' })
  await waitFor(() =>
    expect(screen.getByText('Downloading v1.4.198 (Orca upstream)... 42%')).toBeTruthy()
  )
  expect(upstreamButton().disabled).toBe(true)
  expect(forkButton().disabled).toBe(true)
  expect(checkButton().disabled).toBe(true)

  setStatus({ state: 'downloaded', version: '1.4.198', releaseSource: 'upstream' })
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Restart to Update (1.4.198)' })).toBeTruthy()
  )
  expect(screen.getByText(/1\.4\.198 \(Orca upstream\) is ready to install\./)).toBeTruthy()
  expect(upstreamButton().disabled).toBe(true)
  // Why: a routine check would unpin the staged build while its file still installs on quit.
  expect(checkButton().disabled).toBe(true)
  expect(checkButton().getAttribute('title')).toBe(
    'Restart to install the downloaded update first.'
  )
})

// Why: a staged in-app download occupies the updater, but a download page is only a browser
// tab — and the way out for someone whose in-app jump was refused.
it('keeps download-page buttons usable while an in-app download is staged', async () => {
  listSources.mockResolvedValue(sourceRows({ upstream: { install: 'manual-installer' } }))
  render(<GeneralUpdateSettingsSection />)
  const pageButton = await screen.findByRole<HTMLButtonElement>('button', {
    name: 'Open download page (Orca upstream)'
  })

  setStatus({ state: 'downloading', percent: 5, version: NEWER_FORK_VERSION })
  await waitFor(() => expect(pageButton.disabled).toBe(true))

  setStatus({ state: 'downloaded', version: NEWER_FORK_VERSION })
  await waitFor(() => expect(pageButton.disabled).toBe(false))
  expect(forkButton().disabled).toBe(true)
  fireEvent.click(pageButton)
  expect(openUrl).toHaveBeenCalledWith(UPSTREAM_BUILD.installerUrl)
})

// Why: the list can lag the running build (not yet listed, or withdrawn), and the pinned
// check allows downgrades — equality alone would offer the older listed build as the primary action.
it('never offers an older listed build of the running source', async () => {
  const olderVersion = '1.4.197-swaplabs.202609240800'
  listSources.mockResolvedValue(
    sourceRows({ swaplabs: { latest: { ...FORK_BUILD, version: olderVersion } } })
  )
  render(<GeneralUpdateSettingsSection />)

  const button = await screen.findByRole<HTMLButtonElement>('button', {
    name: `Download ${olderVersion} (SwapLabs)`
  })
  expect(button.disabled).toBe(true)
  expect(button.getAttribute('data-variant')).toBe('secondary')
  expect(button.getAttribute('title')).toBe(
    `You are running a newer build than the newest listed SwapLabs build (${olderVersion}).`
  )
  fireEvent.click(button)
  expect(check).not.toHaveBeenCalled()
  // The other source still compares by nothing: its button stays offered.
  expect(upstreamButton().disabled).toBe(false)
})

it('routes a routine "available" result through the running source button', async () => {
  render(<GeneralUpdateSettingsSection />)
  await waitFor(() => expect(upstreamButton()).toBeTruthy())

  // No releaseSource on the wire: the running source's own check found a newer build.
  setStatus({ state: 'available', version: NEWER_FORK_VERSION, changelog: null })
  const button = await screen.findByRole<HTMLButtonElement>('button', {
    name: `Download ${NEWER_FORK_VERSION} (SwapLabs)`
  })
  expect(button.disabled).toBe(false)
  expect(screen.getByText(/\(SwapLabs\) is available\./)).toBeTruthy()
  fireEvent.click(button)

  expect(download).toHaveBeenCalledTimes(1)
  expect(check).not.toHaveBeenCalled()
})

it('shows a per-source list failure and keeps the other source usable', async () => {
  const message = 'GitHub rate limit reached. Try again in about 3 minutes.'
  listSources.mockResolvedValue(sourceRows({ swaplabs: { latest: null, error: message } }))
  render(<GeneralUpdateSettingsSection />)

  expect(await screen.findByText(`SwapLabs: ${message}`)).toBeTruthy()
  expect(upstreamButton().disabled).toBe(false)
  expect(forkButton('Download (SwapLabs)').disabled).toBe(true)
})

it('links the refused build from a cross-source error', async () => {
  render(<GeneralUpdateSettingsSection />)
  await waitFor(() => expect(upstreamButton()).toBeTruthy())

  setStatus({
    state: 'error',
    message: 'Orca on macOS can only install updates carrying the same code signature.',
    userInitiated: true,
    releaseSource: 'upstream',
    manualInstallUrl: 'https://github.com/stablyai/orca/releases/tag/v1.4.198'
  })

  const link = await screen.findByRole('link', { name: 'Open download page' })
  expect(link.getAttribute('href')).toBe('https://github.com/stablyai/orca/releases/tag/v1.4.198')
  expect(screen.getByText(/Update check failed\. Orca on macOS/)).toBeTruthy()
})

it('re-lists the sources, bypassing the cache, when checking for updates', async () => {
  render(<GeneralUpdateSettingsSection />)
  await waitFor(() => expect(upstreamButton()).toBeTruthy())

  fireEvent.click(checkButton())

  expect(check).toHaveBeenCalledWith({ includePrerelease: false, includePerfPrerelease: false })
  expect(listSources).toHaveBeenLastCalledWith({ force: true })
})

// Why: a local build (Option-click on macOS) is no source's release; it must keep the generic
// action and copy instead of being labelled as the running source's build.
it('keeps a local-build offer out of the source buttons', async () => {
  render(<GeneralUpdateSettingsSection />)
  await waitFor(() => expect(upstreamButton()).toBeTruthy())

  setStatus({ state: 'available', version: '0.9.0-local.1', changelog: null, source: 'local' })
  const button = await screen.findByRole<HTMLButtonElement>('button', {
    name: 'Download Update (0.9.0-local.1)'
  })
  expect(screen.queryByRole('button', { name: /0\.9\.0-local\.1 \(SwapLabs\)/ })).toBeNull()
  expect(forkButton().disabled).toBe(true)
  expect(screen.getByText(/is available\. Click "Download Update" to download it\./)).toBeTruthy()
  expect(screen.queryByText('Release notes')).toBeNull()
  fireEvent.click(button)
  expect(download).toHaveBeenCalledTimes(1)
  expect(check).not.toHaveBeenCalled()

  setStatus({ state: 'downloading', percent: 42, version: '0.9.0-local.1', source: 'local' })
  await waitFor(() => expect(screen.getByText('Downloading v0.9.0-local.1... 42%')).toBeTruthy())
  expect(upstreamButton().disabled).toBe(true)
})
