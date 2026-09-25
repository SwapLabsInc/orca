import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import { dirname } from 'node:path'
import { MacSelfUpdateError } from './mac-self-update-failure'

/** The slice of a fetch `Response` the installer reads. */
export type ReleaseAssetResponse = {
  ok: boolean
  status: number
  body: ReadableStream<Uint8Array<ArrayBuffer>> | null
  arrayBuffer(): Promise<ArrayBuffer>
}

/** `net.fetch`'s shape, injected so the download is testable without Electron. */
export type ReleaseAssetFetch = (
  url: string,
  init?: { signal?: AbortSignal }
) => Promise<ReleaseAssetResponse>

const SMALL_ASSET_TIMEOUT_MS = 10_000
/** A stalled transfer is abandoned after this long without a byte; a slow one is not. */
const DOWNLOAD_IDLE_TIMEOUT_MS = 60_000

/** Fetches a manifest-sized asset whole, refusing anything over `maxBytes`. */
export async function fetchSmallReleaseAsset(
  fetch: ReleaseAssetFetch,
  url: string,
  maxBytes: number
): Promise<Buffer> {
  let response: ReleaseAssetResponse
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(SMALL_ASSET_TIMEOUT_MS) })
  } catch (error) {
    throw new MacSelfUpdateError(
      'manifest-unavailable',
      `Could not reach ${url}: ${error instanceof Error ? error.message : String(error)}`
    )
  }
  if (!response.ok) {
    throw new MacSelfUpdateError(
      'manifest-unavailable',
      `Could not read ${url} (HTTP ${response.status}).`
    )
  }
  const bytes = Buffer.from(await response.arrayBuffer())
  if (bytes.length > maxBytes) {
    throw new MacSelfUpdateError(
      'manifest-malformed',
      `${url} is ${bytes.length} bytes, over the ${maxBytes}-byte limit.`,
      { retryable: false }
    )
  }
  return bytes
}

export type VerifiedDownloadOptions = {
  fetch: ReleaseAssetFetch
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
  const { fetch, url, destinationPath, size, sha512, onProgress, signal } = options
  await mkdir(dirname(destinationPath), { recursive: true })
  const controller = new AbortController()
  const abort = (): void => controller.abort()
  signal?.addEventListener('abort', abort, { once: true })
  let idleTimer: ReturnType<typeof setTimeout> | null = null
  const armIdleTimer = (): void => {
    if (idleTimer) {
      clearTimeout(idleTimer)
    }
    idleTimer = setTimeout(() => controller.abort(), DOWNLOAD_IDLE_TIMEOUT_MS)
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
      response = await fetch(url, { signal: controller.signal })
    } catch (error) {
      throw fail(
        'download-failed',
        `Could not download the update: ${error instanceof Error ? error.message : String(error)}`
      )
    }
    if (!response.ok || !response.body) {
      throw fail('download-failed', `Could not download the update (HTTP ${response.status}).`)
    }
    const hash = createHash('sha512')
    const file = createWriteStream(destinationPath, { mode: 0o600 })
    let transferred = 0
    let lastPercent = -1
    try {
      const reader = response.body.getReader()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) {
          break
        }
        if (controller.signal.aborted) {
          throw fail('download-failed', 'The update download stalled and was abandoned.')
        }
        armIdleTimer()
        transferred += value.byteLength
        // Why stop here: the manifest fixed the size, so extra bytes can only be a wrong or tampered asset.
        if (transferred > size) {
          throw fail(
            'download-size-mismatch',
            `The downloaded update is larger than the ${size} bytes its manifest promised.`
          )
        }
        hash.update(value)
        if (!file.write(value)) {
          await new Promise<void>((resolve) => file.once('drain', resolve))
        }
        const percent = Math.floor((transferred / size) * 100)
        if (percent !== lastPercent) {
          lastPercent = percent
          onProgress?.({ percent, transferred, total: size })
        }
      }
    } finally {
      await new Promise<void>((resolve, reject) => {
        file.end((error?: Error | null) => (error ? reject(error) : resolve()))
      })
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
