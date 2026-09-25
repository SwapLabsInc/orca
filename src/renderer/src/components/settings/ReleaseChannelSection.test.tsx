// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useAppStore } from '../../store'
import { TooltipProvider } from '../ui/tooltip'
import { ReleaseChannelSection } from './ReleaseChannelSection'

// Why hoisted: the source registry reads the define once, when the component's imports load.
const { platformRef, sources } = await vi.hoisted(async () => {
  const sources = await import('../../../../shared/release-sources.fixture')
  sources.setReleaseSourcesLiteralForTest(sources.FORK_RELEASE_SOURCES_LITERAL)
  const platformRef: { current: NodeJS.Platform } = { current: 'darwin' }
  return { platformRef, sources }
})

vi.mock('@/lib/shortcut-platform', () => ({ getShortcutPlatform: () => platformRef.current }))

const FORK_VERSION = '1.4.197-swaplabs.202609241530'
const upstreamBuild = {
  tag: 'v1.4.197',
  version: '1.4.197',
  channel: 'stable',
  name: null,
  publishedAt: null,
  releaseUrl: 'https://github.com/stablyai/orca/releases/tag/v1.4.197',
  installerUrl: 'https://github.com/stablyai/orca/releases/download/v1.4.197/Orca-1.4.197-arm64.dmg'
} as const
const check = vi.fn()
const openUrl = vi.fn()

beforeEach(() => {
  check.mockReset().mockResolvedValue(undefined)
  openUrl.mockReset().mockResolvedValue(undefined)
  useAppStore.setState({ updateStatus: { state: 'idle' }, releaseChannelOverride: null })
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      updater: {
        check,
        getVersion: vi.fn().mockResolvedValue(FORK_VERSION),
        listBuilds: vi
          .fn()
          .mockResolvedValue({ ok: true, channel: 'stable', builds: [upstreamBuild] })
      },
      shell: { openUrl },
      ui: { set: vi.fn().mockResolvedValue(undefined) }
    }
  })
})

afterEach(() => {
  cleanup()
})

afterAll(() => {
  sources.setReleaseSourcesLiteralForTest(null)
})

// Why: the picker lists the primary source's builds, and main refuses every macOS cross-source
// jump — so a fork build on macOS gets the download the refusal would otherwise point at.
function renderSection(): void {
  render(
    <TooltipProvider>
      <ReleaseChannelSection />
    </TooltipProvider>
  )
}

it('offers the installer download for a fork build on macOS, where the jump would be refused', async () => {
  platformRef.current = 'darwin'
  renderSection()

  // The hint renders once the build list has loaded and a row is selected.
  expect(await screen.findByText(/signed differently/)).toBeTruthy()
  const button = screen.getByRole('button', { name: 'Download installer' })
  fireEvent.click(button)

  expect(openUrl).toHaveBeenCalledWith(upstreamBuild.installerUrl)
  expect(check).not.toHaveBeenCalled()
})

it('keeps the in-app switch for a fork build on Linux', async () => {
  platformRef.current = 'linux'
  renderSection()

  expect(await screen.findByText(`${FORK_VERSION} → 1.4.197`)).toBeTruthy()
  const button = screen.getByRole('button', { name: 'Switch to build' })
  fireEvent.click(button)

  expect(check).toHaveBeenCalledWith({ channel: 'stable', targetTag: 'v1.4.197' })
  expect(openUrl).not.toHaveBeenCalled()
})
