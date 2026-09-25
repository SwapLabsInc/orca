import { createHash } from 'node:crypto'
import { join } from 'node:path'
import {
  runProcess,
  type ProcessResult,
  type ProcessSpec
} from '../../../shared/child-process/run-process'
import { compareAppVersions } from '../../../shared/app-version'
import { MacSelfUpdateError } from './mac-self-update-failure'

/** `runProcess`'s shape, injected so every macOS tool call is testable elsewhere. */
export type BundleToolRunner = (spec: ProcessSpec) => Promise<ProcessResult>

const CODESIGN = '/usr/bin/codesign'
const PLIST_BUDDY = '/usr/libexec/PlistBuddy'
const XATTR = '/usr/bin/xattr'
const DITTO = '/usr/bin/ditto'
const QUARANTINE_ATTRIBUTE = 'com.apple.quarantine'
const READ_TIMEOUT_MS = 30_000
// Why long: a deep, strict verification reads every file of a ~500 MB bundle.
const VERIFY_TIMEOUT_MS = 5 * 60_000
const EXTRACT_TIMEOUT_MS = 10 * 60_000

export function hashDesignatedRequirement(requirement: string): string {
  return createHash('sha256').update(requirement.trim(), 'utf8').digest('hex')
}

/** The `designated => …` line of `codesign -d -r-` output (it may land on either stream). */
export function parseDesignatedRequirement(output: string): string | null {
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/^designated => (.+)$/)
    if (match) {
      return match[1].trim()
    }
  }
  return null
}

/**
 * An identity-bound requirement names a certificate, so the next build signed with the same
 * certificate satisfies it too. An ad-hoc signature's requirement is `cdhash H"…"`, bound to
 * that one binary, so no other build can ever match it and in-place updates are impossible.
 */
export function isIdentityBoundDesignatedRequirement(requirement: string): boolean {
  return /\b(?:certificate|anchor)\b/.test(requirement) && !/\bcdhash\b/.test(requirement)
}

function describeExit(result: ProcessResult): string {
  if (result.timedOut) {
    return 'timed out'
  }
  const detail = (result.stderr || result.stdout)
    .split(/\r?\n/)
    .findLast((line) => line.trim().length > 0)
  return `exited with ${result.code ?? result.signal ?? 'unknown'}${detail ? `: ${detail}` : ''}`
}

export async function readDesignatedRequirement(
  appPath: string,
  run: BundleToolRunner = runProcess
): Promise<string> {
  const result = await run({
    program: CODESIGN,
    args: ['-d', '-r-', appPath],
    timeoutMs: READ_TIMEOUT_MS
  })
  const requirement = parseDesignatedRequirement(`${result.stdout}\n${result.stderr}`)
  if (result.code !== 0 || !requirement) {
    throw new MacSelfUpdateError(
      'running-bundle-unsigned',
      `Could not read the code signature of ${appPath} (codesign ${describeExit(result)}).`,
      { retryable: false }
    )
  }
  return requirement
}

async function readInfoPlistString(
  appPath: string,
  key: string,
  run: BundleToolRunner
): Promise<string> {
  const result = await run({
    program: PLIST_BUDDY,
    args: ['-c', `Print :${key}`, join(appPath, 'Contents', 'Info.plist')],
    timeoutMs: READ_TIMEOUT_MS
  })
  if (result.code !== 0) {
    throw new MacSelfUpdateError(
      'bundle-identity-mismatch',
      `Could not read ${key} from the downloaded bundle (PlistBuddy ${describeExit(result)}).`,
      { retryable: false }
    )
  }
  return result.stdout.trim()
}

export type StagedBundleExpectation = {
  bundleId: string
  version: string
  /** Hex sha256 of the running bundle's designated requirement, already matched to the manifest. */
  designatedRequirementSha256: string
}

/**
 * Everything a staged bundle must prove before it may replace the running one, in the order the
 * plan lists: an intact strict signature, the expected identity and version, and the same
 * designated requirement as the running app (the same self-signed certificate).
 */
export async function verifyStagedBundle(
  stagedAppPath: string,
  expected: StagedBundleExpectation,
  run: BundleToolRunner = runProcess
): Promise<void> {
  const verification = await run({
    program: CODESIGN,
    args: ['--verify', '--deep', '--strict', '--verbose=2', stagedAppPath],
    timeoutMs: VERIFY_TIMEOUT_MS
  })
  if (verification.code !== 0) {
    throw new MacSelfUpdateError(
      'bundle-signature-invalid',
      `The downloaded bundle failed code-signature verification (codesign ${describeExit(verification)}). Nothing was installed.`,
      { retryable: false }
    )
  }
  const bundleId = await readInfoPlistString(stagedAppPath, 'CFBundleIdentifier', run)
  if (bundleId !== expected.bundleId) {
    throw new MacSelfUpdateError(
      'bundle-identity-mismatch',
      `The downloaded bundle is "${bundleId}", not ${expected.bundleId}. Nothing was installed.`,
      { retryable: false }
    )
  }
  const version = await readInfoPlistString(stagedAppPath, 'CFBundleShortVersionString', run)
  if (compareAppVersions(version, expected.version) !== 0) {
    throw new MacSelfUpdateError(
      'bundle-version-mismatch',
      `The downloaded bundle is version ${version}, not the ${expected.version} its manifest promised. Nothing was installed.`,
      { retryable: false }
    )
  }
  const requirement = await readDesignatedRequirement(stagedAppPath, run).catch(
    (error: unknown) => {
      throw new MacSelfUpdateError(
        'bundle-signature-invalid',
        `${error instanceof Error ? error.message : String(error)} Nothing was installed.`,
        { retryable: false }
      )
    }
  )
  if (
    hashDesignatedRequirement(requirement) !== expected.designatedRequirementSha256.toLowerCase()
  ) {
    throw new MacSelfUpdateError(
      'signing-identity-mismatch',
      'The downloaded bundle is signed with a different identity than the running app. Nothing was installed.',
      { retryable: false }
    )
  }
}

/** `ditto -x -k` keeps symlinks, resource forks and the signature intact, unlike a plain unzip. */
export async function extractBundleZip(
  zipPath: string,
  destinationDir: string,
  run: BundleToolRunner = runProcess
): Promise<void> {
  const result = await run({
    program: DITTO,
    args: ['-x', '-k', zipPath, destinationDir],
    timeoutMs: EXTRACT_TIMEOUT_MS
  })
  if (result.code !== 0) {
    throw new MacSelfUpdateError(
      'extract-failed',
      `Could not unpack the downloaded update (ditto ${describeExit(result)}).`
    )
  }
}

/**
 * Removes the quarantine flag the bundle may carry so Gatekeeper does not block the relaunch
 * of a build that is not notarized. Runs only after every verification above has passed.
 * A tree without the attribute makes `xattr -d` exit non-zero, so the outcome is checked by
 * reading the bundle's own attribute back rather than by the exit code.
 */
export async function stripQuarantine(
  appPath: string,
  run: BundleToolRunner = runProcess
): Promise<void> {
  await run({
    program: XATTR,
    args: ['-r', '-d', QUARANTINE_ATTRIBUTE, appPath],
    timeoutMs: VERIFY_TIMEOUT_MS
  })
  const check = await run({
    program: XATTR,
    args: ['-p', QUARANTINE_ATTRIBUTE, appPath],
    timeoutMs: READ_TIMEOUT_MS
  })
  if (check.code === 0) {
    throw new MacSelfUpdateError(
      'extract-failed',
      'Could not clear the quarantine flag on the downloaded update.'
    )
  }
}
