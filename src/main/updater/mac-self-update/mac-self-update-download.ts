import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import { dirname } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { MacSelfUpdateError } from './mac-self-update-failure'

/** The slice of a `net.fetch` `Response` the installer reads. */
export type ReleaseAssetResponse = {
  ok: boolean
  status: number
  body: ReadableStream<Uint8Array<ArrayBuffer>> | null
}

/**
 * Electron `net.fetch`'s shape, injected so the download is testable without Electron. The
 * production value is `net.fetch` (Chromium's stack), never Node's global fetch, whose undici
 * can take the process down over an unread body (orca#8695).
 */
export type ReleaseAssetFetch = (
  url: string,
  init?: { signal?: AbortSignal }
) => Promise<ReleaseAssetResponse>

const SMALL_ASSET_TIMEOUT_MS = 10_000
/** A stalled transfer is abandoned after this long without a byte; a slow one is not. */
const DOWNLOAD_IDLE_TIMEOUT_MS = 60_000

const describeError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

/** Drops a body nothing will read, so the connection is not held open behind it. */
async function discardBody(response: ReleaseAssetResponse): Promise<void> {
  await response.body?.cancel().catch(() => undefined)
}

/**
 * Fetches a manifest-sized asset, cutting the transfer off the moment it runs past `maxBytes`,
 * so an oversized response costs at most one chunk over the limit and is never buffered whole.
 */
export async function fetchSmallReleaseAsset(
  fetchAsset: ReleaseAssetFetch,
  url: string,
  maxBytes: number
): Promise<Buffer> {
  let response: ReleaseAssetResponse
  try {
    response = await fetchAsset(url, { signal: AbortSignal.timeout(SMALL_ASSET_TIMEOUT_MS) })
  } catch (error) {
    throw new MacSelfUpdateError(
      'manifest-unavailable',
      `Could not reach ${url}: ${describeError(error)}`
    )
  }
  if (!response.ok) {
    await discardBody(response)
    throw new MacSelfUpdateError(
      'manifest-unavailable',
      `Could not read ${url} (HTTP ${response.status}).`
    )
  }
  if (!response.body) {
    return Buffer.alloc(0)
  }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let received = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) {
        break
      }
      received += value.byteLength
      if (received > maxBytes) {
        throw new MacSelfUpdateError(
          'manifest-malformed',
          `${url} is over the ${maxBytes}-byte limit.`,
          { retryable: false }
        )
      }
      chunks.push(value)
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined)
    if (error instanceof MacSelfUpdateError) {
      throw error
    }
    throw new MacSelfUpdateError(
      'manifest-unavailable',
      `Could not read ${url}: ${describeError(error)}`
    )
  }
  return Buffer.concat(chunks)
}

export type VerifiedDownloadOptions = {
  fetchAsset: ReleaseAssetFetch
  url: string
  destinationPath: string
  /** Exact byte count the signed manifest promised; the transfer stops as soon as it is exceeded. */
  size: number
  /** Base64 sha512 the signed manifest promised. */
  sha512: string
  onProgress?: (progress: { percent: number; transferred: number; total: number }) => void
  signal?: AbortSignal
}

/**
 * Streams the zip to disk, hashing as it goes, and keeps the file only when both the size
 * and the sha512 match the signed manifest. Any failure removes the partial file.
 */
export async function downloadVerifiedReleaseZip(options: VerifiedDownloadOptions): Promise<void> {
  const { fetchAsset, url, destinationPath, size, sha512, onProgress, signal } = options
  const controller = new AbortController()
  const abort = (): void => controller.abort()
  signal?.addEventListener('abort', abort, { once: true })
  let stalled = false
  let idleTimer: ReturnType<typeof setTimeout> | null = null
  const armIdleTimer = (): void => {
    if (idleTimer) {
      clearTimeout(idleTimer)
    }
    idleTimer = setTimeout(() => {
      stalled = true
      controller.abort()
    }, DOWNLOAD_IDLE_TIMEOUT_MS)
    idleTimer.unref?.()
  }
  const fail = (reason: MacSelfUpdateError['reason'], message: string): MacSelfUpdateError =>
    new MacSelfUpdateError(
      reason,
      message,
      reason === 'download-failed' ? {} : { retryable: false }
    )
  try {
    armIdleTimer()
    let response: ReleaseAssetResponse
    try {
      response = await fetchAsset(url, { signal: controller.signal })
    } catch (error) {
      throw fail('download-failed', `Could not download the update: ${describeError(error)}`)
    }
    if (!response.ok || !response.body) {
      await discardBody(response)
      throw fail('download-failed', `Could not download the update (HTTP ${response.status}).`)
    }
    const hash = createHash('sha512')
    let transferred = 0
    let lastPercent = -1
    const verify = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        armIdleTimer()
        transferred += chunk.byteLength
        // Why stop here: the manifest fixed the size, so extra bytes can only be a wrong or tampered asset.
        if (transferred > size) {
          callback(
            fail(
              'download-size-mismatch',
              `The downloaded update is larger than the ${size} bytes its manifest promised.`
            )
          )
          return
        }
        hash.update(chunk)
        const percent = Math.floor((transferred / size) * 100)
        if (percent !== lastPercent) {
          lastPercent = percent
          onProgress?.({ percent, transferred, total: size })
        }
        callback(null, chunk)
      }
    })
    try {
      await mkdir(dirname(destinationPath), { recursive: true })
      // Why pipeline: it owns every stream's error, so a full disk rejects here instead of crashing
      // the process; tearing the source down cancels the body, which aborts the request.
      await pipeline(
        Readable.from(response.body, { objectMode: false }),
        verify,
        createWriteStream(destinationPath, { mode: 0o600 }),
        { signal: controller.signal }
      )
    } catch (error) {
      if (error instanceof MacSelfUpdateError) {
        throw error
      }
      if (stalled) {
        throw fail('download-failed', 'The update download stalled and was abandoned.')
      }
      throw fail('download-failed', `Could not download the update: ${describeError(error)}`)
    }
    if (transferred !== size) {
      throw fail(
        'download-size-mismatch',
        `The downloaded update is ${transferred} bytes, not the ${size} its manifest promised.`
      )
    }
    if (hash.digest('base64') !== sha512) {
      throw fail(
        'download-hash-mismatch',
        'The downloaded update does not match the checksum in its signed manifest.'
      )
    }
  } catch (error) {
    await rm(destinationPath, { force: true }).catch(() => undefined)
    throw error
  } finally {
    if (idleTimer) {
      clearTimeout(idleTimer)
    }
    signal?.removeEventListener('abort', abort)
  }
}
