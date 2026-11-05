import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  FORK_RELEASE_SOURCES_LITERAL,
  setReleaseSourcesLiteralForTest
} from '../../../shared/release-sources.fixture'

const fetchMock = vi.fn()

vi.mock('electron', () => ({
  net: { fetch: (...args: unknown[]) => fetchMock(...args) }
}))

describe('fetchChangelog', () => {
  beforeEach(() => {
    fetchMock.mockReset()
  })

  it('skips the changelog for a build from another release source without fetching', async () => {
    setReleaseSourcesLiteralForTest(FORK_RELEASE_SOURCES_LITERAL)
    try {
      vi.resetModules()
      const { fetchChangelog: forkFetchChangelog } = await import('./updater-changelog')

      expect(
        await forkFetchChangelog('1.4.197-swaplabs.202609241530', '1.4.197-swaplabs.202609241400')
      ).toBeNull()
      expect(fetchMock).not.toHaveBeenCalled()
    } finally {
      setReleaseSourcesLiteralForTest(null)
      vi.resetModules()
    }
  })
})
