import { beforeEach, describe, expect, it, vi } from 'vitest'

const { netFetchMock } = vi.hoisted(() => ({ netFetchMock: vi.fn() }))

vi.mock('electron', () => ({
  net: { fetch: netFetchMock, request: vi.fn() }
}))

describe('probeReleaseManifest', () => {
  beforeEach(() => {
    vi.resetModules()
    netFetchMock.mockReset()
  })

  // Why: a check probes up to six manifests at once, and each names several assets; every HEAD
  // in flight at the same moment used to multiply that.
  it('HEAD-probes the assets a manifest names a few at a time', async () => {
    const assetNames = Array.from({ length: 9 }, (_, index) => `Orca-1.0.0-part${index}.zip`)
    const pendingHeads: (() => void)[] = []
    let inFlight = 0
    let maxInFlight = 0
    netFetchMock.mockImplementation((url: string, init?: { method?: string }) => {
      if (/\/latest(?:-[a-z]+)?\.yml$/.test(url)) {
        return Promise.resolve({
          ok: true,
          status: 200,
          text: () =>
            Promise.resolve(
              [
                'version: 1.0.0',
                'files:',
                ...assetNames.flatMap((name) => [`  - url: ${name}`, '    sha512: test'])
              ].join('\n')
            )
        })
      }
      if (init?.method !== 'HEAD') {
        return Promise.resolve({
          ok: false,
          status: 503,
          text: () => Promise.resolve('')
        })
      }
      inFlight += 1
      maxInFlight = Math.max(maxInFlight, inFlight)
      return new Promise((resolve) => {
        pendingHeads.push(() => {
          inFlight -= 1
          resolve({ ok: true, status: 200, text: () => Promise.resolve('') })
        })
      })
    })
    const { probeReleaseManifest } = await import('./updater-release-asset-readiness')

    const probe = probeReleaseManifest('v1.0.0')
    for (let released = 0; released < assetNames.length; released += 1) {
      await vi.waitFor(() => {
        expect(pendingHeads.length).toBeGreaterThan(0)
      })
      expect(inFlight).toBeLessThanOrEqual(4)
      pendingHeads.shift()?.()
    }

    await expect(probe).resolves.toEqual({
      readiness: 'ready',
      version: '1.0.0'
    })
    expect(maxInFlight).toBe(4)
    expect(netFetchMock.mock.calls.filter(([, init]) => init?.method === 'HEAD')).toHaveLength(9)
  })

  // Why: a check probes several manifests at once; a cap held per manifest still let the check
  // as a whole hold one full cap per manifest.
  it('shares one HEAD budget across every manifest probed with it', async () => {
    const assetNames = Array.from({ length: 6 }, (_, index) => `Orca-part${index}.zip`)
    const pendingHeads: (() => void)[] = []
    let inFlight = 0
    let maxInFlight = 0
    netFetchMock.mockImplementation((url: string, init?: { method?: string }) => {
      if (/\/latest(?:-[a-z]+)?\.yml$/.test(url)) {
        const version = url.includes('/v2.0.0/') ? '2.0.0' : '1.0.0'
        return Promise.resolve({
          ok: true,
          status: 200,
          text: () =>
            Promise.resolve(
              [
                `version: ${version}`,
                'files:',
                ...assetNames.flatMap((name) => [`  - url: ${name}`, '    sha512: test'])
              ].join('\n')
            )
        })
      }
      if (init?.method !== 'HEAD') {
        return Promise.resolve({ ok: false, status: 503, text: () => Promise.resolve('') })
      }
      inFlight += 1
      maxInFlight = Math.max(maxInFlight, inFlight)
      return new Promise((resolve) => {
        pendingHeads.push(() => {
          inFlight -= 1
          resolve({ ok: true, status: 200, text: () => Promise.resolve('') })
        })
      })
    })
    const { AssetProbeBudget, PRIMARY_RELEASE_SOURCE, probeReleaseManifest } =
      await import('./updater-release-asset-readiness').then(async (module) => ({
        ...module,
        PRIMARY_RELEASE_SOURCE: (await import('../shared/release-sources')).PRIMARY_RELEASE_SOURCE
      }))

    const budget = new AssetProbeBudget()
    const probes = Promise.all([
      probeReleaseManifest('v1.0.0', PRIMARY_RELEASE_SOURCE.repo, budget),
      probeReleaseManifest('v2.0.0', PRIMARY_RELEASE_SOURCE.repo, budget)
    ])
    for (let released = 0; released < assetNames.length * 2; released += 1) {
      await vi.waitFor(() => {
        expect(pendingHeads.length).toBeGreaterThan(0)
      })
      expect(inFlight).toBeLessThanOrEqual(4)
      pendingHeads.shift()?.()
    }

    await expect(probes).resolves.toEqual([
      { readiness: 'ready', version: '1.0.0' },
      { readiness: 'ready', version: '2.0.0' }
    ])
    expect(maxInFlight).toBe(4)
    expect(netFetchMock.mock.calls.filter(([, init]) => init?.method === 'HEAD')).toHaveLength(12)
  })

  /** The manifest URL a probe fetched, with its assets answering so the probe settles. */
  async function probeManifestUrl(
    tag: string,
    repo?: string,
    slice?: { platform: NodeJS.Platform; arch: NodeJS.Architecture }
  ): Promise<string> {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')
    const arch = Object.getOwnPropertyDescriptor(process, 'arch')
    if (slice) {
      Object.defineProperty(process, 'platform', { value: slice.platform, configurable: true })
      Object.defineProperty(process, 'arch', { value: slice.arch, configurable: true })
    }
    const manifestUrls: string[] = []
    netFetchMock.mockImplementation((url: string, init?: { method?: string }) => {
      if (init?.method === 'HEAD') {
        return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve('') })
      }
      manifestUrls.push(url)
      return Promise.resolve({
        ok: true,
        status: 200,
        text: () => Promise.resolve('version: 1.0.0\nfiles:\n  - url: Orca.AppImage\n    sha512: t')
      })
    })
    try {
      const { probeReleaseManifest } = await import('./updater-release-asset-readiness')
      await expect(probeReleaseManifest(tag, repo)).resolves.toEqual({
        readiness: 'ready',
        version: '1.0.0'
      })
    } finally {
      if (platform && arch) {
        Object.defineProperty(process, 'platform', platform)
        Object.defineProperty(process, 'arch', arch)
      }
    }
    expect(manifestUrls).toHaveLength(1)
    return manifestUrls[0]
  }

  // Why: electron-builder publishes `latest-linux-arm64.yml` for the arm64 leg; the x64 name
  // used to be fetched on every Linux slice, so an arm64 build read the wrong manifest.
  it('fetches the manifest electron-builder publishes for the running Linux slice', async () => {
    await expect(
      probeManifestUrl('v1.0.0', undefined, { platform: 'linux', arch: 'arm64' })
    ).resolves.toBe(
      'https://github.com/stablyai/orca/releases/download/v1.0.0/latest-linux-arm64.yml'
    )
    await expect(
      probeManifestUrl('v1.0.0', undefined, { platform: 'linux', arch: 'x64' })
    ).resolves.toBe('https://github.com/stablyai/orca/releases/download/v1.0.0/latest-linux.yml')
    await expect(
      probeManifestUrl('v1.0.0', undefined, { platform: 'darwin', arch: 'arm64' })
    ).resolves.toBe('https://github.com/stablyai/orca/releases/download/v1.0.0/latest-mac.yml')
  })

  // Why: a dev-channel tag lives only in its own repo, so the probe must read the repo the pin
  // reads rather than the source's main one.
  it('reads the manifest from the given repo', async () => {
    await expect(
      probeManifestUrl('v1.4.160-hourly.202607281400', 'stablyai/orca-hourly', {
        platform: 'darwin',
        arch: 'arm64'
      })
    ).resolves.toBe(
      'https://github.com/stablyai/orca-hourly/releases/download/v1.4.160-hourly.202607281400/latest-mac.yml'
    )
  })
})
