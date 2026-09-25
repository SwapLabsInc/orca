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
})
