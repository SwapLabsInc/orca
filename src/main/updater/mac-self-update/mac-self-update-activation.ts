import { app, net } from 'electron'
import { runProcess } from '../../../shared/child-process/run-process'
import { ORCA_APP_ID } from '../../../shared/local-build-compatibility'
import { readMacSelfUpdatePublicKey } from '../../../shared/mac-self-update-public-key'
import {
  getReleaseSource,
  getVersionReleaseSource,
  type ReleaseSource
} from '../../../shared/release-sources'
import { getCanonicalUserDataPath } from '../../persistence'
import { recordUpdaterLifecycle } from '../../updater-lifecycle-diagnostics'
import type { UpdateEngine } from '../update-engine'
import {
  hashDesignatedRequirement,
  isIdentityBoundDesignatedRequirement,
  readDesignatedRequirement
} from './mac-self-update-bundle'
import { MacSelfUpdateEngine, type RunningBundleSignature } from './mac-self-update-engine'
import { MacSelfUpdateError } from './mac-self-update-failure'
import { createMacSelfUpdatePublicKey } from './mac-self-update-manifest'
import { resolveMacSelfUpdatePaths, type MacSelfUpdatePaths } from './mac-self-update-paths'

export type MacSelfUpdateSupport =
  | { supported: true; source: ReleaseSource; publicKey: string }
  | {
      supported: false
      reason: 'platform' | 'unpackaged' | 'no-public-key' | 'primary-source' | 'unknown-source'
    }

/**
 * The conditions that can be known without touching the disk (plan §13.2): macOS, a packaged
 * build of a non-primary source, and a compiled-in verification key. Whether the running
 * bundle is signed with a stable identity is checked lazily by `readRunningBundleSignature`.
 */
export function getMacSelfUpdateSupport(): MacSelfUpdateSupport {
  if (process.platform !== 'darwin') {
    return { supported: false, reason: 'platform' }
  }
  if (!app.isPackaged) {
    return { supported: false, reason: 'unpackaged' }
  }
  const publicKey = readMacSelfUpdatePublicKey()
  if (publicKey === null) {
    return { supported: false, reason: 'no-public-key' }
  }
  const sourceId = getVersionReleaseSource(app.getVersion())
  const source = sourceId ? getReleaseSource(sourceId) : null
  if (!source) {
    return { supported: false, reason: 'unknown-source' }
  }
  if (source.prereleaseIdentifier === null) {
    return { supported: false, reason: 'primary-source' }
  }
  return { supported: true, source, publicKey }
}

/** The source whose macOS releases the self-update manifest contract applies to, or null. */
export function getMacSelfUpdateSourceFor(source: ReleaseSource): ReleaseSource | null {
  if (source.prereleaseIdentifier === null || process.platform !== 'darwin') {
    return null
  }
  return getMacSelfUpdateSupport().supported ? source : null
}

export function resolveRunningMacSelfUpdatePaths(): MacSelfUpdatePaths {
  return resolveMacSelfUpdatePaths({
    executablePath: app.getPath('exe'),
    userDataPath: getCanonicalUserDataPath()
  })
}

let runningBundleSignature: Promise<RunningBundleSignature> | null = null

/**
 * Reads the running bundle's designated requirement once. An ad-hoc (cdhash-bound) or
 * unreadable signature means no later build can ever satisfy it, so the installer refuses
 * up front rather than after a download.
 */
export function readRunningBundleSignature(): Promise<RunningBundleSignature> {
  runningBundleSignature ??= (async () => {
    const appPath = resolveRunningMacSelfUpdatePaths().appPath
    const requirement = await readDesignatedRequirement(appPath, runProcess)
    if (!isIdentityBoundDesignatedRequirement(requirement)) {
      throw new MacSelfUpdateError(
        'running-bundle-unsigned',
        'This Orca build is not signed with a stable identity, so it cannot update itself in place. Download the update from the release page and install it by hand.',
        { retryable: false }
      )
    }
    return { designatedRequirementSha256: hashDesignatedRequirement(requirement) }
  })()
  // Why not cached forever: a transient codesign failure must not disable updates for the session.
  runningBundleSignature.catch(() => {
    runningBundleSignature = null
  })
  return runningBundleSignature
}

/** Whether Orca's own installer can act for this build: every static condition plus a stable signing identity. */
export async function isMacSelfUpdateActive(): Promise<boolean> {
  if (!getMacSelfUpdateSupport().supported) {
    return false
  }
  try {
    await readRunningBundleSignature()
    return true
  } catch (error) {
    recordUpdaterLifecycle(
      'mac_self_update_inactive',
      { reason: error instanceof MacSelfUpdateError ? error.reason : 'unknown' },
      { level: 'warn', message: error instanceof Error ? error.message : String(error) }
    )
    return false
  }
}

/**
 * The engine the updater drives instead of electron-updater when the static conditions hold.
 * Built here, not in the engine, so the engine takes only injected dependencies.
 */
export function createMacSelfUpdateEngineIfSupported(): UpdateEngine | null {
  const support = getMacSelfUpdateSupport()
  if (!support.supported) {
    return null
  }
  recordUpdaterLifecycle('mac_self_update_engine_selected', { source: support.source.id })
  return new MacSelfUpdateEngine({
    source: support.source,
    publicKey: createMacSelfUpdatePublicKey(support.publicKey),
    arch: process.arch,
    bundleId: ORCA_APP_ID,
    paths: resolveRunningMacSelfUpdatePaths(),
    getCurrentVersion: () => app.getVersion(),
    readRunningBundleSignature,
    fetchAsset: (url, init) => net.fetch(url, init),
    run: runProcess,
    requestQuit: () => app.quit(),
    getPid: () => process.pid
  })
}
