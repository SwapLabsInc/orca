import { describe, expect, it, vi } from 'vitest'
import type { ReleaseBuild } from '../../../shared/updater/release-channel'
import { ReleaseBuildListCache } from './updater-release-build-cache'

const build = (tag: string): ReleaseBuild => ({
  tag,
  version: tag.slice(1),
  channel: 'hourly',
  name: null,
  publishedAt: null,
  releaseUrl: `https://github.com/stablyai/orca-hourly/releases/tag/${tag}`,
  installerUrl: null
})

describe('ReleaseBuildListCache', () => {
  it('keys by source as well as channel', async () => {
    const load = vi.fn().mockResolvedValue([build('v1.4.160-hourly.202607281400')])
    const cache = new ReleaseBuildListCache(load, 5 * 60_000, () => 1_000_000)

    await cache.list('stable')
    await cache.list('stable', { source: 'swaplabs' })
    await cache.list('stable', { source: 'swaplabs' })

    expect(load.mock.calls).toEqual([
      ['stable', 'upstream'],
      ['stable', 'swaplabs']
    ])
  })
})
