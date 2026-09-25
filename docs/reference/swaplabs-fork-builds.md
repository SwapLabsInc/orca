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
| macOS x64 + arm64 (DMG, zip) | `macos-15` | best-effort | ad-hoc, not notarized |

There is no Windows leg. macOS assets are download-only: the in-app updater cannot
install an ad-hoc build, and Gatekeeper prompts on first launch. Nothing runs
tests; upstream PR CI already gated every mirrored commit, and local changes are
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
