export type HostSlice = { platform?: NodeJS.Platform; arch?: NodeJS.Architecture }

/**
 * Makes `process.platform` / `process.arch` report `slice` until the returned restore runs.
 * Why: the updater names manifests and installers by slice, and the unit shards run on arm64
 * Linux, where an unpinned case probes `latest-linux-arm64.yml` instead of the x64 file it models.
 */
export function setHostSliceForTest(slice: HostSlice): () => void {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')
  const arch = Object.getOwnPropertyDescriptor(process, 'arch')
  if (slice.platform !== undefined) {
    Object.defineProperty(process, 'platform', { value: slice.platform, configurable: true })
  }
  if (slice.arch !== undefined) {
    Object.defineProperty(process, 'arch', { value: slice.arch, configurable: true })
  }
  return () => {
    if (platform) {
      Object.defineProperty(process, 'platform', platform)
    }
    if (arch) {
      Object.defineProperty(process, 'arch', arch)
    }
  }
}
