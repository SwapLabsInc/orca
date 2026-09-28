#!/usr/bin/env node
// LOCAL: Why this exists: the fork workflow sets its packaging identity through
// environment variables that three different readers consume — electron-vite's
// compile-time define (ORCA_RELEASE_SOURCES), electron-builder's publish block
// (ORCA_PUBLISH_OWNER/REPO) and its extraMetadata version (ORCA_LOCAL_BUILD_VERSION).
// A checkout that predates the release-sources change reads none of them and
// packages an app that quietly re-points itself at stablyai/orca. So: load the
// config exactly as electron-builder will, under the same env the build steps
// get, and fail with a sentence someone can act on before a 20-minute build.

import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  SWAPLABS_MAC_SIGN_IDENTITY,
  SWAPLABS_UPDATE_PUBLIC_KEY_ENV,
  parseSwaplabsUpdatePublicKey
} from './swaplabs-mac-update-manifest.mjs'
import {
  SWAPLABS_PRERELEASE_IDENTIFIER,
  isSwaplabsBuildVersion
} from './swaplabs-build-version.mjs'

/** The two sources every SwapLabs build must be compiled with, in the shape the updater parses. */
export const UPSTREAM_RELEASE_SOURCE = { id: 'upstream', repo: 'stablyai/orca' }
export const SWAPLABS_RELEASE_SOURCE = {
  id: 'swaplabs',
  repo: 'SwapLabsInc/orca',
  prereleaseIdentifier: SWAPLABS_PRERELEASE_IDENTIFIER
}

function collectReleaseSourceProblems(raw) {
  if (!raw) {
    return [
      'ORCA_RELEASE_SOURCES is unset; the app would compile with the single upstream source and re-point itself at stablyai/orca.'
    ]
  }
  let sources
  try {
    sources = JSON.parse(raw)
  } catch (error) {
    return [`ORCA_RELEASE_SOURCES is not JSON: ${error.message}`]
  }
  if (!Array.isArray(sources) || sources.some((source) => typeof source !== 'object' || !source)) {
    return ['ORCA_RELEASE_SOURCES must be a JSON array of {id,label,repo,prereleaseIdentifier}.']
  }
  const problems = []
  const ids = sources.map((source) => source.id)
  if (new Set(ids).size !== ids.length) {
    problems.push(`ORCA_RELEASE_SOURCES has duplicate ids: ${ids.join(', ')}`)
  }
  for (const source of sources) {
    if (typeof source.label !== 'string' || !source.label.trim()) {
      problems.push(`ORCA_RELEASE_SOURCES source "${source.id}" has no label.`)
    }
  }
  const upstream = sources.find((source) => source.id === UPSTREAM_RELEASE_SOURCE.id)
  if (upstream?.repo !== UPSTREAM_RELEASE_SOURCE.repo || upstream.prereleaseIdentifier !== null) {
    problems.push(
      `ORCA_RELEASE_SOURCES needs the primary source {id:"upstream", repo:"${UPSTREAM_RELEASE_SOURCE.repo}", prereleaseIdentifier:null}.`
    )
  }
  const swaplabs = sources.find((source) => source.id === SWAPLABS_RELEASE_SOURCE.id)
  if (
    swaplabs?.repo !== SWAPLABS_RELEASE_SOURCE.repo ||
    swaplabs.prereleaseIdentifier !== SWAPLABS_RELEASE_SOURCE.prereleaseIdentifier
  ) {
    problems.push(
      `ORCA_RELEASE_SOURCES needs the fork source {id:"swaplabs", repo:"${SWAPLABS_RELEASE_SOURCE.repo}", prereleaseIdentifier:"${SWAPLABS_RELEASE_SOURCE.prereleaseIdentifier}"}; without it the packaged app cannot recognise its own version.`
    )
  }
  return problems
}

export function collectSwaplabsPackagingProblems({ config, env, platform = process.platform }) {
  const problems = collectReleaseSourceProblems(env.ORCA_RELEASE_SOURCES)

  const [owner, repo] = SWAPLABS_RELEASE_SOURCE.repo.split('/')
  if (env.ORCA_PUBLISH_OWNER !== owner || env.ORCA_PUBLISH_REPO !== repo) {
    problems.push(
      `ORCA_PUBLISH_OWNER/ORCA_PUBLISH_REPO must name ${SWAPLABS_RELEASE_SOURCE.repo}, got "${env.ORCA_PUBLISH_OWNER}/${env.ORCA_PUBLISH_REPO}".`
    )
  }
  // The one that publishes into the wrong repository rather than failing: the
  // checked-out config still hardcodes stablyai/orca and ignores the env above.
  if (config.publish?.owner !== owner || config.publish?.repo !== repo) {
    problems.push(
      `publish target is "${config.publish?.owner}/${config.publish?.repo}" but fork builds must carry ${SWAPLABS_RELEASE_SOURCE.repo}. ` +
        'The checked-out electron-builder config does not honour ORCA_PUBLISH_OWNER/ORCA_PUBLISH_REPO; swaplabs/main needs the release-sources change first.'
    )
  }

  const version = env.ORCA_LOCAL_BUILD_VERSION
  if (!version) {
    problems.push(
      'ORCA_LOCAL_BUILD_VERSION is unset; the app would report the bare upstream version.'
    )
  } else {
    if (!isSwaplabsBuildVersion(version)) {
      problems.push(
        `ORCA_LOCAL_BUILD_VERSION "${version}" is not a SwapLabs build version (<base>-${SWAPLABS_PRERELEASE_IDENTIFIER}.<YYYYMMDDHHMM>[.<delta>]).`
      )
    }
    // Why: the dev-channel and mac-release switches suppress ORCA_LOCAL_BUILD_VERSION,
    // so a stray ORCA_MAC_*/ORCA_WIN_* export packages package.json's version.
    if (config.extraMetadata?.version !== version) {
      problems.push(
        `extraMetadata.version is "${config.extraMetadata?.version}" but the workflow computed "${version}"; an ORCA_MAC_* or ORCA_WIN_* switch is probably set.`
      )
    }
  }

  // Telemetry's transport gate accepts only 'stable' or 'rc'; unvetted fork
  // builds stay silent exactly like the dev channels.
  if (env.ORCA_BUILD_IDENTITY) {
    problems.push(
      `ORCA_BUILD_IDENTITY is "${env.ORCA_BUILD_IDENTITY}" but fork builds must leave it unset.`
    )
  }

  // The public key the app is compiled with must parse, or the packaged updater
  // refuses every manifest and nobody notices until a Mac tries to update.
  if (env[SWAPLABS_UPDATE_PUBLIC_KEY_ENV]) {
    try {
      parseSwaplabsUpdatePublicKey(env[SWAPLABS_UPDATE_PUBLIC_KEY_ENV])
    } catch (error) {
      problems.push(`${SWAPLABS_UPDATE_PUBLIC_KEY_ENV} is unusable: ${error.message}`)
    }
  }

  // macOS signs ad-hoc or with the fork's own certificate: no Developer ID, no
  // notarization, no forced signing, and never an Apple identity that happens
  // to sit in the runner's keychain.
  if (platform === 'darwin') {
    if (env.ORCA_MAC_RELEASE === '1' || config.forceCodeSigning) {
      problems.push(
        'macOS fork builds are ad-hoc or SwapLabs-signed; ORCA_MAC_RELEASE and forceCodeSigning must be off.'
      )
    }
    for (const secret of ['CSC_LINK', 'CSC_KEY_PASSWORD', 'APPLE_ID', 'APPLE_TEAM_ID']) {
      if (env[secret]) {
        problems.push(`${secret} is set; the fork build must not carry Apple signing credentials.`)
      }
    }
    if (env.CSC_NAME !== undefined && env.CSC_NAME !== SWAPLABS_MAC_SIGN_IDENTITY) {
      problems.push(
        `CSC_NAME is ${JSON.stringify(env.CSC_NAME)}; macOS fork builds sign with "${SWAPLABS_MAC_SIGN_IDENTITY}" or ad-hoc, nothing else.`
      )
    }
    if (env.CSC_NAME === SWAPLABS_MAC_SIGN_IDENTITY && !env.CSC_KEYCHAIN) {
      problems.push(
        'CSC_KEYCHAIN is unset; the SwapLabs identity lives in the temporary keychain the workflow imports it into.'
      )
    }
  }

  return problems
}

function main() {
  const require = createRequire(import.meta.url)
  const config = require(resolve(import.meta.dirname, '../electron-builder.config.cjs'))
  const problems = collectSwaplabsPackagingProblems({ config, env: process.env })
  if (problems.length > 0) {
    for (const problem of problems) {
      console.error(`::error::${problem}`)
    }
    process.exit(1)
  }
  console.log(
    `SwapLabs packaging verified: ${config.publish.owner}/${config.publish.repo} @ ${config.extraMetadata.version}`
  )
}

// Why the guard: the test imports the pure collector without running the CLI.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
