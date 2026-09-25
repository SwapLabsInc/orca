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

| Leg                                                   | Runner             | Required    | Signing                                                                                                                                   |
| ----------------------------------------------------- | ------------------ | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Linux x64 (AppImage, deb, rpm)                        | `ubuntu-latest`    | yes         | n/a                                                                                                                                       |
| Linux arm64 (AppImage, deb, rpm)                      | `ubuntu-24.04-arm` | yes         | n/a                                                                                                                                       |
| macOS x64 + arm64 (DMG, update zip + signed manifest) | `macos-15`         | best-effort | SwapLabs self-signed certificate, not notarized; ad-hoc and download-only when the [signing material](#macos-signing-material) is missing |

There is no Windows leg. macOS builds carry no Apple signature, so Gatekeeper
prompts on the first launch of a DMG install either way. Nothing runs tests;
upstream PR CI already gated every mirrored commit, and local changes are
reviewed on their fork PR.

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

### macOS update assets

electron-updater cannot install a fork build on macOS: its `MacUpdater` hands the
zip to Squirrel.Mac, which requires the new bundle to satisfy the running app's
Developer ID designated requirement, and the fork has no Apple credentials. So
`latest-mac.yml` is never uploaded (the leg packages `--mac dmg` only and the
verify step fails on one), and the fork's own updater in the app installs from a
contract of three assets per architecture (`arm64`, `x64`), uploaded in this order:

| Asset                                 | Content                                                                                                                                                                                                                                                            |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `orca-macos-<arch>.zip`               | the signed `Orca.app`, zipped with `ditto -c -k --keepParent` so symlinks and the signature survive `ditto -x -k`                                                                                                                                                  |
| `swaplabs-update-mac-<arch>.json`     | canonical JSON, no whitespace or trailing newline, keys in this order: `schema` (1), `source` (`swaplabs`), `version`, `arch`, `file`, `size`, `sha512` (base64), `bundleId` (`com.stablyai.orca`), `commit` (12 hex), `designatedRequirementSha256`, `releasedAt` |
| `swaplabs-update-mac-<arch>.json.sig` | base64 Ed25519 signature over the manifest's exact bytes                                                                                                                                                                                                           |

`designatedRequirementSha256` is the SHA-256 of the text after `designated => `
in `codesign -d -r- Orca.app`, trimmed. It is stable for one certificate and
bundle id, and the app installs only a bundle whose requirement equals its own;
an ad-hoc signature pins a per-build `cdhash` instead, which the manifest script
refuses, so an unsigned bundle can never be published as installable.

[`config/scripts/swaplabs-mac-update-manifest.mjs`](../../config/scripts/swaplabs-mac-update-manifest.mjs)
`emit` writes the manifest and signature from the bundle and the zip, signing with
the `SWAPLABS_UPDATE_SIGNING_KEY` secret; `verify` re-checks a manifest, its
signature and its zip against the public key in `ORCA_SWAPLABS_UPDATE_PUBLIC_KEY`,
the same value the app is compiled with. The mac leg runs `verify` twice: on the
local files before any upload (a key pair mismatch fails the run, not every user's
update check) and on the assets downloaded back from the release. If that second
check fails, both manifests and signatures are deleted from the release before the
step fails, so a live release never carries a manifest the app would refuse; the
DMGs stay as download-only assets.

In the app bundle, signing is the config's existing path with a different identity:
the keychain step exports `CSC_NAME` (the certificate's common name, `SwapLabs Orca`)
and `CSC_KEYCHAIN`, electron-builder finds the identity through its non-Apple
certificate fallback, and `afterPack` signs the nested helpers through the
`ORCA_COMPUTER_MACOS_SIGN_IDENTITY ?? CSC_NAME` lookup it already had. Hardened
runtime, notarization and `forceCodeSigning` stay off (`ORCA_MAC_RELEASE` unset).

### Version, tag and title

[`config/scripts/swaplabs-build-version.mjs`](../../config/scripts/swaplabs-build-version.mjs)
emits three spellings of one identity; its unit test pins them against what
`orca-fork-ops build-version` produces so the two cannot drift.

| Form          | Example                                                    | Notes                                                                                                                                                      |
| ------------- | ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| App version   | `1.4.197-swaplabs.202609241530`                            | `<base>-swaplabs.<YYYYMMDDHHMM>[.<delta>]`; the base is `package.json` on `swaplabs/main`, keeping any `-rc.N` tail (`1.4.198-rc.1.swaplabs.202609241530`) |
| Release tag   | `swaplabs-v1.4.197+202609241530`                           | orca-fork-ops form; the delta replaces the stamp when `ORCA_SWAPLABS_DELTA` names the build                                                                |
| Release title | `1.4.197-swaplabs.202609241530 • Sep 24, 8:30AM • abc1234` | the updater resolves fork releases by the version in the title and manifest, never by the tag                                                              |

The stamp precedes the delta so builds order by time. `ORCA_BUILD_IDENTITY` stays
unset, so fork builds are silent in telemetry like the dev channels.

### Packaging identity

Every leg is compiled with `ORCA_RELEASE_SOURCES` (the source registry the updater
parses: `upstream` → `stablyai/orca` "Orca upstream", `swaplabs` →
`SwapLabsInc/orca` "SwapLabs"), `ORCA_PUBLISH_OWNER=SwapLabsInc`,
`ORCA_PUBLISH_REPO=orca`, `ORCA_LOCAL_BUILD_VERSION`, `ORCA_BUILD_COMMIT` and
`ORCA_SWAPLABS_UPDATE_PUBLIC_KEY` (the `SWAPLABS_UPDATE_PUBLIC_KEY` variable, empty
when unset, which disables the macOS updater in the app).
[`config/scripts/verify-swaplabs-packaging.mjs`](../../config/scripts/verify-swaplabs-packaging.mjs)
loads `config/electron-builder.config.cjs` under that env before the app build and
fails if the config does not honour it, which is what happens on a checkout that
predates the release-sources change. On macOS it also refuses any `CSC_NAME` other
than the SwapLabs identity and a public key that does not parse.

## macOS signing material

The mac leg signs and publishes update manifests only when three Actions secrets
and one variable exist on `SwapLabsInc/orca`; with any of them missing it prints a
`::warning::` naming what is absent and builds the ad-hoc, download-only DMG. A
maintainer creates them once, on macOS or Linux with `openssl` on `PATH`:

```sh
node config/scripts/swaplabs-mac-signing-setup.mjs --out-dir ~/swaplabs-signing
```

[`config/scripts/swaplabs-mac-signing-setup.mjs`](../../config/scripts/swaplabs-mac-signing-setup.mjs)
refuses a directory inside the repository and never overwrites existing material.
It generates a self-signed RSA-2048 code-signing certificate (CN `SwapLabs Orca`,
Code Signing EKU, 10 years by default, `--days` to change) packed as a
password-protected `.p12`, plus an Ed25519 key pair for the manifest, then prints
the `gh secret set` / `gh variable set` commands and the public key. No secret is
printed.

| Name                          | Kind     | Value                                                                                                       |
| ----------------------------- | -------- | ----------------------------------------------------------------------------------------------------------- |
| `SWAPLABS_UPDATE_SIGNING_KEY` | secret   | Ed25519 private key, PKCS8 PEM (`swaplabs-update-signing-key.pem`)                                          |
| `SWAPLABS_MAC_CERT_P12`       | secret   | base64 of `swaplabs-mac-cert.p12`                                                                           |
| `SWAPLABS_MAC_CERT_PASSWORD`  | secret   | contents of `swaplabs-mac-cert.password`                                                                    |
| `SWAPLABS_UPDATE_PUBLIC_KEY`  | variable | raw 32-byte Ed25519 public key, base64; compiled into every fork build as `ORCA_SWAPLABS_UPDATE_PUBLIC_KEY` |

In the run, the `.p12` is imported into a keychain created for the job under
`$RUNNER_TEMP` with a random password, the decoded file is removed immediately, and
the certificate is added as a code-signing trust root in the admin domain, because
`security find-identity -v` (what electron-builder and osx-sign consult) lists only
trusted identities and a self-signed certificate is its own root. The keychain and
the trust setting are removed at the end of the job. The `.p12` uses the
SHA1/3DES container algorithms on purpose: OpenSSL 3's AES default is rejected by
`security import`.

Rotating either key strands installed builds: the app accepts only its own
certificate's designated requirement and only manifests signed by the key it was
compiled with. Treat the output directory as the only copy and back it up
privately.

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
- The keychain import, trust and `codesign` behaviour of the mac leg was written
  from the documented `security` commands and electron-builder's identity lookup,
  not exercised on a Mac; its first real run is the test. In particular
  `sudo security add-trusted-cert -d` is what makes a self-signed identity
  "valid" headlessly, and `codesign -d -r-` must print a `designated =>`
  requirement that names the certificate rather than a `cdhash`.
