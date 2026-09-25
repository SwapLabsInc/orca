# SwapLabs fork builds

`LOCAL:` the SwapLabs fork (`SwapLabsInc/orca`) builds its integration branch,
`swaplabs/main`, with its own pipeline and publishes the result as a public
prerelease on the fork's own releases page. Installed fork builds update from
that source; upstream releases never replace them. This page covers what
triggers a build, where it lands and how to force one. The fork policy (which
branch a change goes to, the `LOCAL:` prefix) lives in the `orca-fork-maintenance`
skill, and the manual build procedure in `orca-fork-ops`.

## What triggers a build

[`.github/workflows/swaplabs-build.yml`](../../.github/workflows/swaplabs-build.yml)
runs on every push to `swaplabs/main`. A mirror sync ends with a push there, so a
sync is a build. The workflow only runs when `github.repository` is
`SwapLabsInc/orca`, like upstream's release workflows only run on `stablyai/orca`.

Runs are serialised in one concurrency group: a burst of pushes collapses to the
newest queued run, and a run that is already uploading is never cancelled. The
first job also skips the build when the branch head already has a published fork
release (it reads the commit recorded in the newest release body), so re-running
a sync that changed nothing costs a few seconds.

Legs:

| Leg | Runner | Required | Signing |
| --- | --- | --- | --- |
| Linux x64 (AppImage, deb, rpm) | `ubuntu-latest` | yes | n/a |
| Linux arm64 (AppImage, deb, rpm) | `ubuntu-24.04-arm` | yes | n/a |
| macOS x64 + arm64 (DMG, plus the self-update assets below) | `macos-15` | best-effort | self-signed certificate, not notarized (ad-hoc and download-only when the signing secrets are missing) |

There is no Windows leg. Gatekeeper prompts on the first launch of a macOS
build installed by hand. Nothing runs tests; upstream PR CI already gated every
mirrored commit, and local changes are reviewed on their fork PR.

## Where it lands

Releases publish to `https://github.com/SwapLabsInc/orca/releases` with
`GITHUB_TOKEN`; no App token or PAT is involved. Each run:

1. computes one identity in the preflight job (see below) so both Linux legs stamp
   the same version minute;
2. creates a **draft** release under the fork tag, targeting the built commit;
3. builds each leg with `--publish never` and uploads its artifacts with
   `gh release upload` (electron-builder's publisher can only upload into
   `v<version>`, which is not the fork tag form);
4. verifies `latest-linux.yml` and `latest-linux-arm64.yml` are uploaded, carry the
   stamped version and sit next to their AppImages;
5. flips the draft live as a prerelease and prunes the series to the newest 30;
6. discards the draft whenever the publish job did not succeed. The macOS leg
   never gates the flip, so a macOS failure — before or after it — leaves a live
   release without macOS assets rather than blocking or removing it.

### Version, tag and title

[`config/scripts/swaplabs-build-version.mjs`](../../config/scripts/swaplabs-build-version.mjs)
emits three spellings of one identity; its unit test pins them against what
`orca-fork-ops build-version` produces so the two cannot drift.

| Form | Example | Notes |
| --- | --- | --- |
| App version | `1.4.197-swaplabs.202609241530` | `<base>-swaplabs.<YYYYMMDDHHMM>[.<delta>]`; the base is `package.json` on `swaplabs/main`, keeping any `-rc.N` tail (`1.4.198-rc.1.swaplabs.202609241530`) |
| Release tag | `swaplabs-v1.4.197+202609241530` | orca-fork-ops form; the delta replaces the stamp when `ORCA_SWAPLABS_DELTA` names the build |
| Release title | `1.4.197-swaplabs.202609241530 • Sep 24, 8:30AM • abc1234` | the updater resolves fork releases by the version in the title and manifest, never by the tag |

The stamp precedes the delta so builds order by time. `ORCA_BUILD_IDENTITY` stays
unset, so fork builds are silent in telemetry like the dev channels.

### Packaging identity

Every leg is compiled with `ORCA_RELEASE_SOURCES` (the source registry the updater
parses: `upstream` → `stablyai/orca` "Orca upstream", `swaplabs` →
`SwapLabsInc/orca` "SwapLabs"), `ORCA_PUBLISH_OWNER=SwapLabsInc`,
`ORCA_PUBLISH_REPO=orca`, `ORCA_LOCAL_BUILD_VERSION` and `ORCA_BUILD_COMMIT`.
[`config/scripts/verify-swaplabs-packaging.mjs`](../../config/scripts/verify-swaplabs-packaging.mjs)
loads `config/electron-builder.config.cjs` under that env before the app build and
fails if the config does not honour it, which is what happens on a checkout that
predates the release-sources change.

## macOS self-updates (SwapLabs → SwapLabs)

`LOCAL:` upstream's macOS updater hands the downloaded zip to Squirrel.Mac, which
only installs a bundle that satisfies the running app's Developer ID designated
requirement. A fork build cannot meet that, so a SwapLabs build on macOS updates
itself through Orca's own installer in `src/main/updater/mac-self-update/`. It is
shaped like electron-updater (same events, same `checkForUpdates` /
`downloadUpdate` / `quitAndInstall` surface), so the updater state machine, the
Updates buttons, the update card, nudges, the quit-and-install sequence and the
exit watchdog run unchanged. Everything else (Linux, upstream builds, cross-source
jumps) still goes through electron-updater or a manual download.

### When it is active

All of these must hold, or the Mac assets stay download-only ("Open download
page"):

- macOS, packaged build;
- the running version belongs to a non-primary source (`…-swaplabs.<stamp>`);
- the build was compiled with `ORCA_SWAPLABS_UPDATE_PUBLIC_KEY` (the raw 32-byte
  Ed25519 public key, base64; validated by `electron.vite.config.ts` like the
  source registry);
- the running bundle's designated requirement is identity-bound (`certificate
  leaf = …`), read once with `codesign -d -r-`. An ad-hoc signature is
  `cdhash`-bound, so no later build could ever match it; the installer then
  refuses up front and the buttons say manual.

`requiresManualInstall` says manual for a fork build's own next macOS build unless
the installer is active; cross-source jumps stay manual on macOS and Windows.

While the installer is active, "Check for local build" is refused before its file
dialog opens: the loopback feed serves `latest-mac.yml`, which the installer cannot
verify, and a local build is never signed with the SwapLabs release identity, so it
could not be installed anyway. The message says to install a local build by hand.

### Release assets the app consumes

Per macOS slice (`arm64`, `x64`), uploaded in this order, manifest last:

1. `orca-macos-<arch>.zip` — the `.app`, `ditto -c -k --keepParent`.
2. `swaplabs-update-mac-<arch>.json` — canonical JSON, no trailing newline:
   `schema` (1), `source` (`swaplabs`), `version`, `arch`, `file`, `size`,
   `sha512` (base64), `bundleId` (`com.stablyai.orca`), `commit`,
   `designatedRequirementSha256` (hex sha256 of the text after `designated => `
   in `codesign -d -r- <app>`, trimmed), `releasedAt` (ISO-8601). The name is
   `<source id>-update-mac-<arch>.json`, so another source would publish its own.
3. `swaplabs-update-mac-<arch>.json.sig` — base64 Ed25519 signature over the
   exact bytes of (2).

`latest-mac.yml` stays absent so electron-updater never tries Squirrel. The
atom-feed readiness probe, the pinned-tag verification and the Updates-section
listing all read the JSON manifest in place of `latest-mac.yml` on a build where
the installer is supported, and treat the `.sig` as a required asset.

### What a check, a download and a restart do

- **Check**: the existing atom-feed preflight pins the newest fork tag, then the
  engine fetches the manifest and its signature through Electron's `net` (64 KiB /
  1 KiB caps, enforced while the body streams so an oversized response is cut off
  rather than buffered) and refuses
  unless, in this order, the signature verifies, the manifest parses, `source`,
  `arch` and `bundleId` match, the version belongs to the source and is newer
  (routine) or exactly the pinned target, and `designatedRequirementSha256`
  equals the running bundle's. Nothing is read from the manifest before the
  signature check.
- **Download**: the zip streams into `<userData>/mac-self-update/downloads/`
  through a stream pipeline, under the size and sha512 the signed manifest fixed
  (a transfer past the size is abandoned; a full or unwritable disk is a retryable
  error, not a crash), then `ditto -x -k` unpacks it into `.<App>-update-staging/`
  beside the bundle, on the same volume so the swap is a rename. The staged
  bundle must pass `codesign --verify --deep --strict`, carry the expected
  `CFBundleIdentifier` and `CFBundleShortVersionString`, and have the same
  designated requirement as the running app. Only then is
  `com.apple.quarantine` stripped and `update-downloaded` emitted, which is also
  the installer-ready signal Squirrel would have given. Any failure removes the
  staging directory and the zip, and the error status carries the tag's release
  page as `manualInstallUrl`. An unwritable app location is refused before the
  download starts. Nothing from the download is executed at any point; the only
  programs run are `codesign`, `PlistBuddy`, `ditto` and `xattr` under `/usr`.
- **Restart to update**: the existing quit-and-install sequence runs (session
  save, terminal daemon handling, exit watchdog, supervised serve handoff), then
  the engine records `install-state.json` and starts a detached `/bin/sh -c`
  helper. The script is a fixed string in `mac-self-update-helper.ts`; every path
  and number is an argv entry. It waits for the app pid to exit, moves the bundle
  to `.<App>-update-rollback/`, moves the staged bundle into place, relaunches
  with `/usr/bin/open`, and waits up to 90 s for the health marker the new app
  writes once its first window is shown (or after 20 s headless). Without it, the
  helper restores the rollback and relaunches the previous build. Every earlier
  failure that leaves the previous bundle in place (staged bundle missing, no
  rollback folder, either rename refused) relaunches it as well, so a failed
  update never leaves Orca closed. Under a supervised `orca serve`, the helper
  only swaps and the supervisor relaunches.
- **Next launch**: `reportMacSelfUpdateLaunchOutcome` writes the health marker,
  records `updater_mac_self_update_completed` or `…_failed` with the helper's
  one-word outcome, shows a rollback as an error in the update card, discards a
  bundle that never installed, and prunes the rollback a few minutes after a
  healthy launch.

### Not verified on a real Mac

- TCC grants surviving the swap with the self-signed identity.
- Gatekeeper on relaunch after the quarantine strip, for a non-notarized bundle.
- Renaming the bundle under a still-running terminal daemon.
- `open` relaunching promptly after the previous instance's exit.

## How to force a build

From the Actions tab pick **SwapLabs Fork Build**, **Run workflow**, tick
**force**. Or:

```sh
gh workflow run swaplabs-build.yml --repo SwapLabsInc/orca --ref swaplabs/main -f force=true
```

`force` bypasses the freshness skip only. The workflow always builds the tip of
`swaplabs/main`, whatever ref the workflow file was dispatched from, so a dispatch
from a topic branch cannot ship that branch under the fork identity. Every `gh`
call names `--repo`; the fork's parent is `stablyai/orca` and `gh` defaults there.

To build by hand, follow `orca-fork-ops` §2 and export the same packaging identity
the workflow sets (`ORCA_RELEASE_SOURCES`, `ORCA_PUBLISH_OWNER`, `ORCA_PUBLISH_REPO`)
before packaging, or the local build is single-source and re-points itself at
upstream.

## First-run checklist

None of this has run on the fork yet; these were not verifiable from a checkout:

- Actions must be enabled on `SwapLabsInc/orca`, with workflow permissions set to
  read and write so `GITHUB_TOKEN` can create releases.
- The org must be able to allocate `ubuntu-24.04-arm` and `macos-15` hosted runners.
- The `swaplabs/main` checkout must carry the release-sources change; the
  packaging verification step fails by name otherwise.
