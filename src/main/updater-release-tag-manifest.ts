// LOCAL: what a release tag's manifest proves about the build its feed advertises.

import { getVersionReleaseSource, type ReleaseSource } from '../shared/release-sources'
import { compareVersions, isValidVersion } from './updater-fallback'
import { probeReleaseManifest, type ReleaseManifestProbe } from './updater-release-asset-readiness'
import { getMacSelfUpdateSourceFor } from './updater/mac-self-update/mac-self-update-activation'

export function isSourceVersion(version: string, source: ReleaseSource): boolean {
  return isValidVersion(version) && getVersionReleaseSource(version) === source.id
}

/** The manifest names what electron-updater installs; only the advertised build of this source may be offered under the tag. */
function manifestNamesAdvertisedVersion(
  probe: ReleaseManifestProbe,
  version: string,
  source: ReleaseSource
): boolean {
  return (
    probe.version !== null &&
    isSourceVersion(probe.version, source) &&
    compareVersions(probe.version, version) === 0
  )
}

/** What a tag's manifest proves about the build advertised as `version`: `mismatch` names another build or source. */
export type ReleaseTagManifestVerdict =
  | { kind: 'ready' }
  | { kind: 'not-ready' }
  | { kind: 'unavailable' }
  | { kind: 'mismatch'; manifestVersion: string }

export function judgeManifestProbe(
  probe: ReleaseManifestProbe,
  version: string,
  source: ReleaseSource
): ReleaseTagManifestVerdict {
  if (probe.version !== null && !manifestNamesAdvertisedVersion(probe, version, source)) {
    return { kind: 'mismatch', manifestVersion: probe.version }
  }
  // Why: a manifest that names no version cannot prove which build it installs.
  return {
    kind: probe.readiness === 'ready' && probe.version === null ? 'not-ready' : probe.readiness
  }
}

/** A tag, the version it advertises, and the repo its feed reads — a dev channel's repo is not its source's own. */
export type ReleaseTagTarget = {
  tag: string
  version: string
  repo: string
}

/** Reads the manifest published under the target's tag in its repo and says whether it installs the advertised version of `source` on this platform. */
export async function verifyReleaseTagManifest(
  target: ReleaseTagTarget,
  source: ReleaseSource
): Promise<ReleaseTagManifestVerdict> {
  return judgeManifestProbe(
    await probeReleaseManifest(
      target.tag,
      target.repo,
      undefined,
      getMacSelfUpdateSourceFor(source)
    ),
    target.version,
    source
  )
}
