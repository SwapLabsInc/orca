import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  downloadVerifiedReleaseZip,
  fetchSmallReleaseAsset,
  type ReleaseAssetFetch
} from './mac-self-update-download'
import { createReleaseAssetResponse, toResponseChunk } from './mac-self-update-engine.fixture'
import { MacSelfUpdateError } from './mac-self-update-failure'

function respond(status: number, chunks: Uint8Array[]): ReleaseAssetFetch {
  return async () => createReleaseAssetResponse(status, chunks)
}

/**
 * A real `Response` over a pull-driven body, like `net.fetch` hands back: it reports how many
 * chunks were pulled and whether the reader gave up on it.
 */
function respondInChunks(
  chunkBytes: number,
  chunkCount: number
): { fetchAsset: ReleaseAssetFetch; pulled: () => number; cancelled: () => boolean } {
  let pulled = 0
  let cancelled = false
  const body = new ReadableStream<Uint8Array<ArrayBuffer>>({
    pull(controller) {
      pulled += 1
      controller.enqueue(toResponseChunk(Buffer.alloc(chunkBytes, 'm')))
      if (pulled === chunkCount) {
        controller.close()
      }
    },
    cancel() {
      cancelled = true
    }
  })
  return {
    fetchAsset: async () => new Response(body, { status: 200 }),
    pulled: () => pulled,
    cancelled: () => cancelled
  }
}

const sha512 = (bytes: Buffer): string => createHash('sha512').update(bytes).digest('base64')

describe('mac self-update download', () => {
  let dir: string
  let destination: string
  const payload = Buffer.from('x'.repeat(10_000), 'utf8')

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'orca-mac-self-update-'))
    destination = join(dir, 'downloads', 'orca-macos-arm64.zip')
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('keeps a download whose size and sha512 match the manifest and reports progress', async () => {
    const progress: number[] = []
    await downloadVerifiedReleaseZip({
      fetchAsset: respond(200, [payload.subarray(0, 4000), payload.subarray(4000)]),
      url: 'https://example.invalid/orca-macos-arm64.zip',
      destinationPath: destination,
      size: payload.length,
      sha512: sha512(payload),
      onProgress: ({ percent }) => progress.push(percent)
    })
    expect(readFileSync(destination)).toEqual(payload)
    expect(progress).toEqual([40, 100])
  })

  it.each([
    ['fewer bytes than promised', payload.length + 1, sha512(payload), 'download-size-mismatch'],
    ['more bytes than promised', payload.length - 1, sha512(payload), 'download-size-mismatch'],
    ['a different checksum', payload.length, sha512(Buffer.from('other')), 'download-hash-mismatch']
  ])('removes a download with %s', async (_label, size, expectedSha512, reason) => {
    await expect(
      downloadVerifiedReleaseZip({
        fetchAsset: respond(200, [payload]),
        url: 'https://example.invalid/orca-macos-arm64.zip',
        destinationPath: destination,
        size,
        sha512: expectedSha512
      })
    ).rejects.toMatchObject({ reason, presentation: { retryable: false } })
    expect(existsSync(destination)).toBe(false)
  })

  it('reports an HTTP failure as retryable and leaves no file behind', async () => {
    await expect(
      downloadVerifiedReleaseZip({
        fetchAsset: respond(503, []),
        url: 'https://example.invalid/orca-macos-arm64.zip',
        destinationPath: destination,
        size: payload.length,
        sha512: sha512(payload)
      })
    ).rejects.toMatchObject({ reason: 'download-failed', presentation: {} })
    expect(existsSync(destination)).toBe(false)
  })

  // Why: a write stream's error is an uncaught exception unless something consumes it; before the
  // pipeline did, a full or unwritable disk took the whole main process down mid-download.
  it('reports a destination the file system refuses as a retryable failure', async () => {
    mkdirSync(destination, { recursive: true })
    await expect(
      downloadVerifiedReleaseZip({
        fetchAsset: respond(200, [payload]),
        url: 'https://example.invalid/orca-macos-arm64.zip',
        destinationPath: destination,
        size: payload.length,
        sha512: sha512(payload)
      })
    ).rejects.toMatchObject({
      reason: 'download-failed',
      message: expect.stringMatching(/EISDIR|illegal operation on a directory/),
      presentation: {}
    })
  })

  it('stops reading an oversized small asset at the limit instead of buffering it whole', async () => {
    const oversized = respondInChunks(16, 200)
    await expect(
      fetchSmallReleaseAsset(oversized.fetchAsset, 'https://example.invalid/m.json', 64)
    ).rejects.toMatchObject({ reason: 'manifest-malformed', presentation: { retryable: false } })
    // Five 16-byte chunks cross 64 bytes; the reader must give up there, not after all 200.
    expect(oversized.pulled()).toBeLessThan(10)
    expect(oversized.cancelled()).toBe(true)
  })

  it('fetches a small asset whole and refuses one over the limit', async () => {
    const bytes = await fetchSmallReleaseAsset(
      respond(200, [Buffer.from('{"schema":1}')]),
      'https://example.invalid/m.json',
      64
    )
    expect(bytes.toString('utf8')).toBe('{"schema":1}')
    await expect(
      fetchSmallReleaseAsset(respond(200, [payload]), 'https://example.invalid/m.json', 64)
    ).rejects.toBeInstanceOf(MacSelfUpdateError)
    await expect(
      fetchSmallReleaseAsset(respond(404, []), 'https://example.invalid/m.json', 64)
    ).rejects.toMatchObject({ reason: 'manifest-unavailable' })
  })
})
