import {
  findInstallerAssetName,
  hasInstallableArtifactForPlatform
} from '../../../shared/updater/release-channel'
import { getMacSelfUpdateAssetNames } from '../../../shared/updater/mac-self-update-assets'
import type { ReleaseSource } from '../../../shared/updater/release-sources'

/**
 * LOCAL: on a build Orca's own installer updates, a release is installable once this slice's zip,
 * signed manifest and signature are all attached: the installer fetches each and nothing else, so
 * a release caught between uploads (or carrying only a DMG or a stray `latest-mac.yml`) would
 * fail on selection. A non-primary source's macOS release the installer does not apply to (a
 * build that can only install by hand, or another source's release) is installed by hand from
 * its DMG, and it publishes no `latest-mac.yml` that the platform rule could read. Everywhere
 * else the platform's electron-updater manifest decides.
 */
export function hasInstallableArtifact(
  assetNames: readonly string[],
  platform: NodeJS.Platform,
  arch: NodeJS.Architecture,
  source: ReleaseSource,
  macSelfUpdateSource: ReleaseSource | null
): boolean {
  if (macSelfUpdateSource !== null) {
    return getMacSelfUpdateAssetNames(macSelfUpdateSource, arch).every((name) =>
      assetNames.includes(name)
    )
  }
  if (platform === 'darwin' && source.prereleaseIdentifier !== null) {
    return findInstallerAssetName(platform, assetNames, arch) !== null
  }
  return hasInstallableArtifactForPlatform(platform, assetNames)
}
