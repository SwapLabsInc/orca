import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setHostSliceForTest } from './updater-host-slice.fixture'

const { netFetchMock } = vi.hoisted(() => ({ netFetchMock: vi.fn() }))

vi.mock('electron', () => ({
  net: { fetch: netFetchMock, request: vi.fn() }
}))

/** A response whose body streams `chunks`, as `net.fetch` hands the probe; `text()` reads it whole. */
function streamedResponse(chunks: Uint8Array[], onCancel?: () => void) {
  let next = 0
  return {
    ok: true,
    status: 200,
    headers: new Headers(),
    body: new ReadableStream<Uint8Array>({
      pull(controller) {
        if (next >= chunks.length) {
          controller.close()
          return
        }
        controller.enqueue(chunks[next++])
      },
      cancel() {
        onCancel?.()
      }
    }),
    text: () => Promise.resolve(new TextDecoder().decode(Buffer.concat(chunks)))
  }
}

const SWAPLABS_SOURCE = {
  id: 'swaplabs',
  label: 'SwapLabs',
  repo: 'SwapLabsInc/orca',
  prereleaseIdentifier: 'swaplabs'
}

// Why x64: the cases that name a manifest or asset model the x64 slice; arm64 ones pin their own.
let restoreHostSlice = (): void => {}

describe('probeReleaseManifest', () => {
  beforeEach(() => {
    vi.resetModules()
    netFetchMock.mockReset()
    restoreHostSlice = setHostSliceForTest({ arch: 'x64' })
  })

  afterEach(() => {
    restoreHostSlice()
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
    const restoreSlice = slice ? setHostSliceForTest(slice) : null
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
      restoreSlice?.()
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

  // LOCAL: on a build with Orca's own macOS installer, a fork tag's readiness is its signed
  // per-slice manifest: the zip it names and the detached signature must both be there.
  it('reads a fork macOS slice through its self-update manifest and requires the signature', async () => {
    const swaplabs = SWAPLABS_SOURCE
    const restoreSlice = setHostSliceForTest({ arch: 'arm64' })
    const probed: string[] = []
    const manifest = JSON.stringify({
      schema: 1,
      version: '1.4.197-swaplabs.202609251200',
      file: 'orca-macos-arm64.zip'
    })
    let signatureStatus = 200
    netFetchMock.mockImplementation((url: string, init?: { method?: string }) => {
      if (init?.method === 'HEAD') {
        probed.push(url)
        const status = url.endsWith('.sig') ? signatureStatus : 200
        return Promise.resolve({ ok: status === 200, status, text: () => Promise.resolve('') })
      }
      probed.push(url)
      return Promise.resolve(streamedResponse([new TextEncoder().encode(manifest)]))
    })
    try {
      const { probeReleaseManifest } = await import('./updater-release-asset-readiness')
      const tag = 'swaplabs-v1.4.197+202609251200'
      await expect(probeReleaseManifest(tag, swaplabs.repo, undefined, swaplabs)).resolves.toEqual({
        readiness: 'ready',
        version: '1.4.197-swaplabs.202609251200'
      })
      const base = `https://github.com/SwapLabsInc/orca/releases/download/${encodeURIComponent(tag)}`
      expect(probed).toEqual([
        `${base}/swaplabs-update-mac-arm64.json`,
        `${base}/orca-macos-arm64.zip`,
        `${base}/swaplabs-update-mac-arm64.json.sig`
      ])

      signatureStatus = 404
      await expect(probeReleaseManifest(tag, swaplabs.repo, undefined, swaplabs)).resolves.toEqual({
        readiness: 'not-ready',
        version: '1.4.197-swaplabs.202609251200'
      })
    } finally {
      restoreSlice()
    }
  })

  // LOCAL: the manifest is unsigned as far as the probe knows, so an address it names must never
  // be requested: a compromised release could point background checks at any host.
  it.each([
    ['an absolute URL', { file: 'http://127.0.0.1:8080/orca-macos-arm64.zip' }],
    ['a path outside the release', { file: '../orca-macos-arm64.zip' }],
    ['another slice', { file: 'orca-macos-x64.zip' }],
    ['a files list', { file: 'orca-macos-arm64.zip', files: [{ url: 'http://169.254.169.254/' }] }]
  ])(
    'refuses a fork manifest naming %s as not ready without requesting it',
    async (_label, fields) => {
      const restoreSlice = setHostSliceForTest({ arch: 'arm64' })
      const heads: string[] = []
      const manifest = JSON.stringify({
        schema: 1,
        version: '1.4.197-swaplabs.202609251200',
        ...fields
      })
      netFetchMock.mockImplementation((url: string, init?: { method?: string }) => {
        if (init?.method === 'HEAD') {
          heads.push(url)
          return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve('') })
        }
        return Promise.resolve(streamedResponse([new TextEncoder().encode(manifest)]))
      })
      try {
        const { probeReleaseManifest } = await import('./updater-release-asset-readiness')
        await expect(
          probeReleaseManifest(
            'swaplabs-v1.4.197+202609251200',
            SWAPLABS_SOURCE.repo,
            undefined,
            SWAPLABS_SOURCE
          )
        ).resolves.toEqual({ readiness: 'not-ready', version: '1.4.197-swaplabs.202609251200' })
        expect(heads).toEqual([])
      } finally {
        restoreSlice()
      }
    }
  )

  // LOCAL: the probe reads a fork manifest before anything about it is verified, so a release
  // serving an oversized one must be cut off at the installer's own cap, never buffered whole.
  it('cuts off a fork manifest past the installer size cap without buffering or probing it', async () => {
    const restoreSlice = setHostSliceForTest({ arch: 'arm64' })
    const chunkBytes = 16 * 1024
    // Valid JSON in full, so reading it whole would have answered 'ready' after the asset probes.
    const oversized = JSON.stringify({
      schema: 1,
      version: '1.4.197-swaplabs.202609251200',
      file: 'orca-macos-arm64.zip',
      padding: 'x'.repeat(8 * chunkBytes)
    })
    const bytes = new TextEncoder().encode(oversized)
    const chunks: Uint8Array[] = []
    for (let offset = 0; offset < bytes.length; offset += chunkBytes) {
      chunks.push(bytes.subarray(offset, offset + chunkBytes))
    }
    let cancelled = false
    const heads: string[] = []
    netFetchMock.mockImplementation((url: string, init?: { method?: string }) => {
      if (init?.method === 'HEAD') {
        heads.push(url)
        return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve('') })
      }
      return Promise.resolve(
        streamedResponse(chunks, () => {
          cancelled = true
        })
      )
    })
    try {
      const { probeReleaseManifest } = await import('./updater-release-asset-readiness')
      await expect(
        probeReleaseManifest(
          'swaplabs-v1.4.197+202609251200',
          SWAPLABS_SOURCE.repo,
          undefined,
          SWAPLABS_SOURCE
        )
      ).resolves.toEqual({ readiness: 'not-ready', version: null })
      expect(cancelled).toBe(true)
      expect(heads).toEqual([])
    } finally {
      restoreSlice()
    }
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
