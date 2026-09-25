import { EventEmitter } from 'node:events'
import { access, mkdir, mkdtemp, readdir, rm, rmdir } from 'node:fs/promises'
import { constants as fsConstants } from 'node:fs'
import { join } from 'node:path'
import type { KeyObject } from 'node:crypto'
import type { ReleaseSource } from '../../../shared/release-sources'
import {
  getMacSelfUpdateManifestName,
  getMacSelfUpdateSignatureName
} from '../../../shared/mac-self-update-assets'
import { recordUpdaterLifecycle } from '../../updater-lifecycle-diagnostics'
import type { UpdateEngine, UpdateEngineFeed } from '../update-engine'
import {
  extractBundleZip,
  stripQuarantine,
  verifyStagedBundle,
  type BundleToolRunner
} from './mac-self-update-bundle'
import {
  downloadVerifiedReleaseZip,
  fetchSmallReleaseAsset,
  type ReleaseAssetFetch
} from './mac-self-update-download'
import { MacSelfUpdateError } from './mac-self-update-failure'
import type { HelperSpawner } from './mac-self-update-helper'
import { requestMacSelfUpdateInstall } from './mac-self-update-install-request'
import { verifyMacSelfUpdateManifest, type MacSelfUpdateManifest } from './mac-self-update-manifest'
import type { MacSelfUpdatePaths } from './mac-self-update-paths'

const MAX_MANIFEST_BYTES = 64 * 1024
const MAX_SIGNATURE_BYTES = 1024

/** The running bundle's signing identity, read once per process. */
export type RunningBundleSignature = { designatedRequirementSha256: string }

export type MacSelfUpdateEngineDependencies = {
  source: ReleaseSource
  publicKey: KeyObject
  arch: NodeJS.Architecture
  bundleId: string
  paths: MacSelfUpdatePaths
  getCurrentVersion: () => string
  /** Rejects with a `MacSelfUpdateError` when the running bundle is not identity-signed. */
  readRunningBundleSignature: () => Promise<RunningBundleSignature>
  fetch: ReleaseAssetFetch
  run: BundleToolRunner
  spawnHelper?: HelperSpawner
  relaunchProgram?: string
  requestQuit: () => void
  getPid: () => number
}

type VerifiedOffer = { manifest: MacSelfUpdateManifest; feedUrl: string; manualInstallUrl: string }
type StagedBundle = { appPath: string; manifest: MacSelfUpdateManifest }

/** The tag's release page: the way out when the in-app path refuses. */
function toReleasePageUrl(feedUrl: string): string {
  return feedUrl.replace('/releases/download/', '/releases/tag/')
}

/**
 * LOCAL: Orca's own macOS installer for SwapLabs builds, shaped like electron-updater so the
 * updater state machine cannot tell them apart. Nothing from a release is trusted until its
 * signature checks out, and nothing is executed before the staged bundle passes verification.
 */
export class MacSelfUpdateEngine extends EventEmitter implements UpdateEngine {
  autoDownload = false
  autoInstallOnAppQuit = false
  autoRunAppAfterInstall = true
  allowPrerelease = false
  allowDowngrade = false
  disableDifferentialDownload = false
  logger: UpdateEngine['logger'] = null
  readonly installerReadinessSource = 'staged-bundle' as const
  private feed: UpdateEngineFeed | null = null
  private offer: VerifiedOffer | null = null
  private staged: StagedBundle | null = null
  private downloadInFlight: Promise<string[]> | null = null

  constructor(private readonly deps: MacSelfUpdateEngineDependencies) {
    super()
  }

  setFeedURL(options: UpdateEngineFeed): void {
    this.feed = options
  }

  /** Resolves null like electron-updater; failures are emitted as `error` and rethrown, also like it. */
  async checkForUpdates(): Promise<null> {
    this.emit('checking-for-update')
    try {
      this.offer = await this.readVerifiedOffer()
      // Why: a later check must not leave an older staged bundle for Restart to install.
      if (this.staged && this.staged.manifest.version !== this.offer.manifest.version) {
        this.staged = null
        await rm(this.deps.paths.stagingDir, { recursive: true, force: true }).catch(
          () => undefined
        )
      }
      this.emit('update-available', this.describe(this.offer.manifest))
    } catch (error) {
      if (error instanceof MacSelfUpdateError && error.reason === 'version-not-newer') {
        this.offer = null
        this.emit('update-not-available', { version: this.deps.getCurrentVersion() })
        return null
      }
      this.offer = null
      this.fail('check_refused', error)
    }
    return null
  }

  async downloadUpdate(): Promise<string[]> {
    if (!this.downloadInFlight) {
      this.downloadInFlight = this.stageOffer().finally(() => {
        this.downloadInFlight = null
      })
    }
    return this.downloadInFlight
  }

  quitAndInstall(_isSilent?: boolean, isForceRunAfter?: boolean): void {
    const staged = this.staged
    if (!staged) {
      this.emit(
        'error',
        new MacSelfUpdateError('nothing-staged', 'No verified update is staged. Download it again.')
      )
      return
    }
    try {
      requestMacSelfUpdateInstall({
        paths: this.deps.paths,
        appPid: this.deps.getPid(),
        currentVersion: this.deps.getCurrentVersion(),
        staged: { appPath: staged.appPath, version: staged.manifest.version },
        // Why the supervisor rule: MacUpdater ignores these flags, so the caller expresses relaunch
        // ownership through autoRunAppAfterInstall; either says the serve supervisor relaunches.
        helperRelaunches: this.autoRunAppAfterInstall && isForceRunAfter !== false,
        relaunchProgram: this.deps.relaunchProgram,
        spawnHelper: this.deps.spawnHelper
      })
    } catch (error) {
      this.emit('error', error instanceof Error ? error : new Error(String(error)))
      return
    }
    this.deps.requestQuit()
  }

  private describe(manifest: MacSelfUpdateManifest) {
    return {
      version: manifest.version,
      files: [{ url: manifest.file, sha512: manifest.sha512, size: manifest.size }],
      path: manifest.file,
      sha512: manifest.sha512,
      releaseDate: manifest.releasedAt
    }
  }

  private fail(event: string, error: unknown): never {
    const failure = error instanceof Error ? error : new Error(String(error))
    recordUpdaterLifecycle(
      `mac_self_update_${event}`,
      { reason: error instanceof MacSelfUpdateError ? error.reason : failure.name },
      { level: 'warn', message: failure.message }
    )
    this.emit('error', failure)
    throw failure
  }

  private async readVerifiedOffer(): Promise<VerifiedOffer> {
    const feed = this.feed
    if (!feed) {
      throw new MacSelfUpdateError('no-feed', 'No release feed is pinned.')
    }
    const manualInstallUrl = toReleasePageUrl(feed.url)
    const withManualUrl = (error: unknown): never => {
      if (error instanceof MacSelfUpdateError && error.reason !== 'version-not-newer') {
        throw new MacSelfUpdateError(error.reason, error.message, {
          ...error.presentation,
          manualInstallUrl
        })
      }
      throw error
    }
    try {
      const running = await this.deps.readRunningBundleSignature()
      const manifestName = getMacSelfUpdateManifestName(this.deps.source, this.deps.arch)
      const [manifestBytes, signatureBytes] = await Promise.all([
        fetchSmallReleaseAsset(this.deps.fetch, `${feed.url}/${manifestName}`, MAX_MANIFEST_BYTES),
        fetchSmallReleaseAsset(
          this.deps.fetch,
          `${feed.url}/${getMacSelfUpdateSignatureName(manifestName)}`,
          MAX_SIGNATURE_BYTES
        )
      ])
      const manifest = verifyMacSelfUpdateManifest(
        manifestBytes,
        signatureBytes.toString('utf8'),
        this.deps.publicKey,
        {
          source: this.deps.source,
          arch: this.deps.arch,
          bundleId: this.deps.bundleId,
          currentVersion: this.deps.getCurrentVersion(),
          expectedVersion: feed.expectedVersion ?? null,
          allowDowngrade: this.allowDowngrade,
          runningDesignatedRequirementSha256: running.designatedRequirementSha256
        }
      )
      return { manifest, feedUrl: feed.url, manualInstallUrl }
    } catch (error) {
      return withManualUrl(error)
    }
  }

  private async assertAppLocationWritable(manualInstallUrl: string): Promise<void> {
    const { paths } = this.deps
    try {
      await access(paths.appPath, fsConstants.W_OK)
      // Why a real probe as well: `access` answers from mode bits, and macOS ACLs can still refuse.
      await rmdir(await mkdtemp(join(paths.stagingDir, 'probe-')))
    } catch (error) {
      throw new MacSelfUpdateError(
        'app-location-unwritable',
        `Orca cannot replace itself at ${paths.appPath} (${error instanceof Error ? error.message : String(error)}). Download the update from the release page and install it by hand.`,
        { manualInstallUrl, retryable: false }
      )
    }
  }

  private async stageOffer(): Promise<string[]> {
    const offer = this.offer
    if (!offer) {
      this.fail(
        'download_refused',
        new MacSelfUpdateError('nothing-staged', 'Check for updates first.')
      )
    }
    const { manifest, feedUrl, manualInstallUrl } = offer
    const { paths } = this.deps
    const zipPath = join(paths.downloadsDir, manifest.file)
    this.staged = null
    try {
      await rm(paths.stagingDir, { recursive: true, force: true })
      await mkdir(paths.stagingDir, { recursive: true })
      await this.assertAppLocationWritable(manualInstallUrl)
      await downloadVerifiedReleaseZip({
        fetch: this.deps.fetch,
        url: `${feedUrl}/${manifest.file}`,
        destinationPath: zipPath,
        size: manifest.size,
        sha512: manifest.sha512,
        onProgress: ({ percent, transferred, total }) =>
          this.emit('download-progress', {
            percent,
            transferred,
            total,
            delta: 0,
            bytesPerSecond: 0
          })
      })
      await extractBundleZip(zipPath, paths.stagingDir, this.deps.run)
      await rm(zipPath, { force: true })
      const bundles = (await readdir(paths.stagingDir)).filter((name) => /\.app$/i.test(name))
      if (bundles.length !== 1) {
        throw new MacSelfUpdateError(
          'extract-failed',
          `The downloaded update holds ${bundles.length} app bundles, not one. Nothing was installed.`,
          { retryable: false }
        )
      }
      const stagedAppPath = join(paths.stagingDir, bundles[0])
      const running = await this.deps.readRunningBundleSignature()
      await verifyStagedBundle(
        stagedAppPath,
        {
          bundleId: this.deps.bundleId,
          version: manifest.version,
          designatedRequirementSha256: running.designatedRequirementSha256
        },
        this.deps.run
      )
      await stripQuarantine(stagedAppPath, this.deps.run)
      this.staged = { appPath: stagedAppPath, manifest }
      recordUpdaterLifecycle('mac_self_update_staged', { version: manifest.version })
      this.emit('update-downloaded', { ...this.describe(manifest), downloadedFile: stagedAppPath })
      return [stagedAppPath]
    } catch (error) {
      await rm(paths.stagingDir, { recursive: true, force: true }).catch(() => undefined)
      await rm(zipPath, { force: true }).catch(() => undefined)
      const presented =
        error instanceof MacSelfUpdateError
          ? new MacSelfUpdateError(error.reason, error.message, {
              manualInstallUrl,
              ...error.presentation
            })
          : error
      this.fail('download_refused', presented)
    }
  }
}
