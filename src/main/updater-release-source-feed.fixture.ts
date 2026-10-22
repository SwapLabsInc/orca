import { vi, type Mock } from 'vitest'

/**
 * LOCAL: the fork's members of the shared `updater-prerelease-feed` mock: download URLs for any
 * release source's repository, and the pinned tag's manifest check.
 */
export function createSourceFeedMocks(): {
  verifyReleaseTagManifestMock: Mock<(...args: unknown[]) => unknown>
  members: {
    getReleaseDownloadUrl: (tag: string, source?: { repo: string }) => string
    verifyReleaseTagManifest: Mock<(...args: unknown[]) => unknown>
  }
  reset: () => void
} {
  const verifyReleaseTagManifestMock = vi.fn<(...args: unknown[]) => unknown>()
  return {
    verifyReleaseTagManifestMock,
    members: {
      getReleaseDownloadUrl: (tag, source) =>
        `https://github.com/${source?.repo ?? 'stablyai/orca'}/releases/download/${tag}`,
      verifyReleaseTagManifest: verifyReleaseTagManifestMock
    },
    // Why ready: only a test about a disagreeing manifest should see a refusal.
    reset: () => {
      verifyReleaseTagManifestMock.mockReset().mockResolvedValue({ kind: 'ready' })
    }
  }
}
