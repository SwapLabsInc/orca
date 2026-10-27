import { vi, type Mock } from 'vitest'

/** The harness's app mock, which the mac self-update engine also asks for `getPath('exe')`. */
type HarnessAppMock = { getVersion: Mock<() => string> }

type SourceFeedMocks = {
  /** Resolves `{ kind: 'ready' }` unless a test says the pinned tag's manifest disagrees. */
  verifyReleaseTagManifestMock: Mock<(...args: unknown[]) => unknown>
}

/**
 * LOCAL: the fork's members of the shared updater harness: download URLs for any release source's
 * repository, the pinned tag's manifest check, and the app path the mac self-update engine reads.
 * `extend` adds the fork's mocks and their reset to the harness's own, which sits at its line limit.
 */
export function createSourceFeedMocks(app: HarnessAppMock): {
  members: {
    getReleaseDownloadUrl: (tag: string, source?: { repo: string }) => string
    verifyReleaseTagManifest: Mock<(...args: unknown[]) => unknown>
  }
  mocks: SourceFeedMocks
  extend: <T extends { resetUpdaterMocks: () => void }>(mocks: T) => T & SourceFeedMocks
} {
  Object.assign(app, { getPath: vi.fn(() => '/Applications/Orca.app/Contents/MacOS/Orca') })
  const verifyReleaseTagManifestMock = vi.fn<(...args: unknown[]) => unknown>()
  return {
    members: {
      getReleaseDownloadUrl: (tag, source) =>
        `https://github.com/${source?.repo ?? 'stablyai/orca'}/releases/download/${tag}`,
      verifyReleaseTagManifest: verifyReleaseTagManifestMock
    },
    mocks: { verifyReleaseTagManifestMock },
    extend: (mocks) => ({
      ...mocks,
      verifyReleaseTagManifestMock,
      resetUpdaterMocks: () => {
        mocks.resetUpdaterMocks()
        // Why ready: only a test about a disagreeing manifest should see a refusal.
        verifyReleaseTagManifestMock.mockReset().mockResolvedValue({ kind: 'ready' })
      }
    })
  }
}
