import { describe, expect, it, vi } from 'vitest'
import type { ProcessResult, ProcessSpec } from '../../../shared/child-process/run-process'
import {
  extractBundleZip,
  hashDesignatedRequirement,
  isIdentityBoundDesignatedRequirement,
  parseDesignatedRequirement,
  readDesignatedRequirement,
  stripQuarantine,
  verifyStagedBundle
} from './mac-self-update-bundle'

const DR = 'identifier "com.stablyai.orca" and certificate leaf = H"abc123"'
const CODESIGN_DISPLAY = `Executable=/Applications/Orca.app/Contents/MacOS/Orca\ndesignated => ${DR}\n`

type Step = { match: (spec: ProcessSpec) => boolean; result: Partial<ProcessResult> }

function ok(stdout = ''): ProcessResult {
  return { code: 0, signal: null, stdout, stderr: '', timedOut: false }
}

/** A runner scripted per tool: unmatched calls succeed with empty output, and every call is recorded. */
function scriptedRunner(steps: Step[]) {
  const calls: ProcessSpec[] = []
  const run = vi.fn(async (spec: ProcessSpec): Promise<ProcessResult> => {
    calls.push(spec)
    const step = steps.find((candidate) => candidate.match(spec))
    return { ...ok(), ...step?.result }
  })
  return { run, calls }
}

const isTool =
  (program: string, ...args: string[]) =>
  (spec: ProcessSpec) =>
    spec.program.endsWith(program) && args.every((arg) => spec.args?.includes(arg))

describe('designated requirement helpers', () => {
  it('reads the designated requirement line from either stream and hashes it trimmed', () => {
    expect(parseDesignatedRequirement(CODESIGN_DISPLAY)).toBe(DR)
    expect(parseDesignatedRequirement('nothing here')).toBeNull()
    expect(hashDesignatedRequirement(`  ${DR}\n`)).toBe(hashDesignatedRequirement(DR))
    expect(hashDesignatedRequirement(DR)).toMatch(/^[0-9a-f]{64}$/)
  })

  it('tells an identity-bound requirement from an ad-hoc cdhash one', () => {
    expect(isIdentityBoundDesignatedRequirement(DR)).toBe(true)
    expect(isIdentityBoundDesignatedRequirement('cdhash H"0011"')).toBe(false)
    expect(isIdentityBoundDesignatedRequirement('identifier "x"')).toBe(false)
  })

  it('reads the running bundle requirement and refuses an unreadable signature', async () => {
    const { run } = scriptedRunner([
      { match: isTool('codesign', '-d'), result: { stderr: CODESIGN_DISPLAY } }
    ])
    await expect(readDesignatedRequirement('/Applications/Orca.app', run)).resolves.toBe(DR)
    const failing = scriptedRunner([
      { match: isTool('codesign', '-d'), result: { code: 1, stderr: 'code object is not signed' } }
    ])
    await expect(
      readDesignatedRequirement('/Applications/Orca.app', failing.run)
    ).rejects.toMatchObject({ reason: 'running-bundle-unsigned' })
  })
})

describe('verifyStagedBundle', () => {
  const staged = '/Applications/.Orca-update-staging/Orca.app'
  const expected = {
    bundleId: 'com.stablyai.orca',
    version: '1.4.197-swaplabs.202609251200',
    designatedRequirementSha256: hashDesignatedRequirement(DR)
  }
  const healthy: Step[] = [
    {
      match: isTool('PlistBuddy', 'Print :CFBundleIdentifier'),
      result: { stdout: 'com.stablyai.orca\n' }
    },
    {
      match: isTool('PlistBuddy', 'Print :CFBundleShortVersionString'),
      result: { stdout: '1.4.197-swaplabs.202609251200\n' }
    },
    { match: isTool('codesign', '-d'), result: { stdout: CODESIGN_DISPLAY } }
  ]

  it('runs a strict deep verification first, then identity, version and requirement checks', async () => {
    const { run, calls } = scriptedRunner(healthy)
    await verifyStagedBundle(staged, expected, run)
    expect(calls[0]).toMatchObject({
      program: '/usr/bin/codesign',
      args: ['--verify', '--deep', '--strict', '--verbose=2', staged]
    })
    expect(calls.map((call) => call.program)).toEqual([
      '/usr/bin/codesign',
      '/usr/libexec/PlistBuddy',
      '/usr/libexec/PlistBuddy',
      '/usr/bin/codesign'
    ])
    expect(calls[1].args).toEqual([
      '-c',
      'Print :CFBundleIdentifier',
      `${staged}/Contents/Info.plist`
    ])
  })

  it.each([
    [
      'signature verification',
      [{ match: isTool('codesign', '--verify'), result: { code: 1, stderr: 'invalid signature' } }],
      'bundle-signature-invalid'
    ],
    [
      'bundle identifier',
      [
        {
          match: isTool('PlistBuddy', 'Print :CFBundleIdentifier'),
          result: { stdout: 'com.other\n' }
        }
      ],
      'bundle-identity-mismatch'
    ],
    [
      'version',
      [
        {
          match: isTool('PlistBuddy', 'Print :CFBundleShortVersionString'),
          result: { stdout: '1.4.196\n' }
        }
      ],
      'bundle-version-mismatch'
    ],
    [
      'designated requirement',
      [{ match: isTool('codesign', '-d'), result: { stdout: 'designated => cdhash H"00"\n' } }],
      'signing-identity-mismatch'
    ]
  ])('refuses a staged bundle that fails the %s check', async (_label, overrides, reason) => {
    const { run } = scriptedRunner([...overrides, ...healthy])
    await expect(verifyStagedBundle(staged, expected, run)).rejects.toMatchObject({
      reason,
      presentation: { retryable: false }
    })
  })
})

describe('extraction and quarantine', () => {
  it('extracts with ditto and strips the quarantine flag, verifying by reading it back', async () => {
    const { run, calls } = scriptedRunner([
      { match: isTool('xattr', '-p'), result: { code: 1, stderr: 'No such xattr' } }
    ])
    await extractBundleZip('/tmp/a.zip', '/Applications/.Orca-update-staging', run)
    await stripQuarantine('/Applications/.Orca-update-staging/Orca.app', run)
    expect(calls[0]).toMatchObject({
      program: '/usr/bin/ditto',
      args: ['-x', '-k', '/tmp/a.zip', '/Applications/.Orca-update-staging']
    })
    expect(calls[1].args).toEqual([
      '-r',
      '-d',
      'com.apple.quarantine',
      '/Applications/.Orca-update-staging/Orca.app'
    ])
  })

  it('fails extraction on a non-zero ditto exit and quarantine removal when the flag survives', async () => {
    const failing = scriptedRunner([
      { match: isTool('ditto'), result: { code: 1, stderr: 'ditto: bad archive' } }
    ])
    await expect(extractBundleZip('/tmp/a.zip', '/tmp/out', failing.run)).rejects.toMatchObject({
      reason: 'extract-failed'
    })
    const sticky = scriptedRunner([
      { match: isTool('xattr', '-p'), result: { code: 0, stdout: '0083;' } }
    ])
    await expect(stripQuarantine('/tmp/Orca.app', sticky.run)).rejects.toMatchObject({
      reason: 'extract-failed'
    })
  })
})
