import type { ReleaseSource } from '../../shared/release-sources'
import type { ReleaseTagManifestVerdict } from '../updater-prerelease-feed'

/** Why a message per verdict: the dev picked this tag by hand, so the refusal must say what the release actually holds. */
export function describeRefusedPinnedManifest(
  verdict: Exclude<ReleaseTagManifestVerdict, { kind: 'ready' }>,
  tag: string,
  version: string,
  source: ReleaseSource
): string {
  const release = `${source.prereleaseIdentifier === null ? '' : `${source.label} `}release "${tag}"`
  switch (verdict.kind) {
    case 'mismatch':
      return `The ${release} advertises ${version}, but its update manifest installs ${verdict.manifestVersion}. Nothing was installed.`
    case 'not-ready':
      return `The ${release} has no installable build for this platform yet.`
    case 'unavailable':
      return `Could not read the ${release} manifest. Check your connection and try again.`
  }
}

/** Why per platform: each names the signature check the downloaded build would fail. */
export function describeRefusedCrossSourceJump(source: ReleaseSource): string {
  if (process.platform === 'win32') {
    return `Orca on Windows only installs updates signed by the running build's publisher, and ${source.label} builds are signed differently. Download the ${source.label} installer from its release page and run it by hand.`
  }
  return `Orca on macOS can only install updates carrying the same code signature, and ${source.label} builds are signed differently. Download the ${source.label} build from its release page and install it by hand.`
}

/**
 * Why refuse before the file dialog: Orca's own macOS installer installs only bundles carrying
 * the running build's release identity under a release-key-signed manifest, which a local
 * build has no way to produce, so the loopback feed could never get past its check.
 */
export function describeRefusedLocalBuildSwitch(source: ReleaseSource | null): string {
  const identity = source ? `the ${source.label} release identity` : 'its release identity'
  return `Local build switching is unavailable on this build. It updates itself through Orca's own installer, which installs only builds signed with ${identity}; install a local build by hand instead.`
}
