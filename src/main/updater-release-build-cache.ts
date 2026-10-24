import type { ReleaseBuild, ReleaseChannel } from '../shared/release-channel'
import { PRIMARY_RELEASE_SOURCE, type ReleaseSourceId } from '../shared/release-sources'

const DEFAULT_TTL_MS = 5 * 60_000

type LoadBuilds = (channel: ReleaseChannel, sourceId: ReleaseSourceId) => Promise<ReleaseBuild[]>

type CacheEntry = { builds: Promise<ReleaseBuild[]>; expiresAt: number }

export type ReleaseBuildListOptions = {
  force?: boolean
  /** Which release source to list; defaults to the primary. */
  source?: ReleaseSourceId
}

// Repeated picker mounts/channel switches share API results and in-flight requests.
export class ReleaseBuildListCache {
  private readonly entries = new Map<string, CacheEntry>()

  constructor(
    private readonly load: LoadBuilds,
    private readonly ttlMs: number = DEFAULT_TTL_MS,
    private readonly now: () => number = Date.now
  ) {}

  list(channel: ReleaseChannel, options: ReleaseBuildListOptions = {}): Promise<ReleaseBuild[]> {
    const sourceId = options.source ?? PRIMARY_RELEASE_SOURCE.id
    const key = `${sourceId}:${channel}`
    const existing = this.entries.get(key)
    if (!options.force && existing && existing.expiresAt > this.now()) {
      return existing.builds
    }
    const builds = this.load(channel, sourceId)
    const entry: CacheEntry = { builds, expiresAt: this.now() + this.ttlMs }
    this.entries.set(key, entry)
    // Retry failed loads, but do not evict a newer forced reload.
    builds.catch(() => {
      if (this.entries.get(key) === entry) {
        this.entries.delete(key)
      }
    })
    return builds
  }
}
