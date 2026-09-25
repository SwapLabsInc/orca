import type { ReleaseSource } from './release-sources'

/**
 * LOCAL: the release assets a non-primary source publishes per macOS slice so
 * Orca's own installer can update a SwapLabs build in place (the pipeline
 * produces them, the app consumes them; keep both sides in step):
 *
 * 1. `orca-macos-<arch>.zip` — the .app bundle, `ditto -c -k --keepParent`.
 * 2. `<source id>-update-mac-<arch>.json` — canonical JSON manifest naming the
 *    zip, its size and sha512, the bundle id, version, arch and the sha256 of
 *    the bundle's designated requirement.
 * 3. `<manifest>.sig` — base64 Ed25519 signature over the manifest's exact bytes.
 *
 * `latest-mac.yml` stays absent so electron-updater never tries Squirrel.Mac,
 * which would refuse a bundle that is not Developer ID signed.
 */

export const MAC_SELF_UPDATE_ARCHITECTURES = ['arm64', 'x64'] as const

export type MacSelfUpdateArchitecture = (typeof MAC_SELF_UPDATE_ARCHITECTURES)[number]

export function isMacSelfUpdateArchitecture(arch: string): arch is MacSelfUpdateArchitecture {
  return MAC_SELF_UPDATE_ARCHITECTURES.some((known) => known === arch)
}

export function getMacSelfUpdateManifestName(
  source: ReleaseSource,
  arch: NodeJS.Architecture
): string {
  return `${source.id}-update-mac-${arch}.json`
}

export function getMacSelfUpdateSignatureName(manifestName: string): string {
  return `${manifestName}.sig`
}

/** The zip the manifest must name; anything else is a publishing error, not a build to install. */
export function getMacSelfUpdateZipName(arch: NodeJS.Architecture): string {
  return `orca-macos-${arch}.zip`
}
