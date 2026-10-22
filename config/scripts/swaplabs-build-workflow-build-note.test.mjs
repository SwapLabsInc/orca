import { describe, expect, it } from 'vitest'
import { jobs, runWorkflowShell, stepNamed } from './swaplabs-build-workflow-shell.mjs'

// LOCAL: the fork build tells SwapLabsInc/SwapLabs's Slack note workflow how it
// ended; that workflow validates the payload. Like the devvms wake-up, nothing
// here may fail the build.

const job = jobs['notify-build']
const step = stepNamed(job, 'Tell the SwapLabs Slack note workflow how the build ended')
const TAG = 'swaplabs-v1.4.214+202610221735'
const SHA = 'abcdef0123'.repeat(4)
// A stand-in gh that records its arguments and succeeds unless told to fail.
const mock = `gh() { printf '%s\\n' "$@" > "$RUNNER_TEMP/gh-args"; [[ "\${GH_FAILS:-}" != 1 ]]; }`
const run = (env) =>
  runWorkflowShell(`${step.run}\ncat "$RUNNER_TEMP/gh-args" 2>/dev/null`, {
    mock,
    env: {
      GH_TOKEN: 'token',
      PUBLISHED: '',
      CANCELLED: 'false',
      TAG,
      SHA,
      GITHUB_RUN_ID: '42',
      ...env
    }
  })

describe('swaplabs fork build reports how it ended', () => {
  it('runs for every build that started, without waiting for macOS', () => {
    expect(job.needs).toEqual(['preflight', 'draft', 'build-linux', 'publish'])
    expect(job.if).toContain('always()')
    expect(job.if).toContain("github.repository == 'SwapLabsInc/orca'")
    expect(job.if).toContain("needs.preflight.outputs.should_build == 'true'")
    expect(job.permissions).toEqual({})
    expect(step.env.GH_TOKEN).toBe('${{ secrets.SWAPLABS_DEVVMS_DISPATCH_TOKEN }}')
  })

  it('dispatches a published build with its release tag', async () => {
    const result = await run({ PUBLISHED: 'true' })
    expect(result.exitCode, result.stderr).toBe(0)
    expect(result.stdout).toContain('repos/SwapLabsInc/SwapLabs/dispatches')
    for (const field of [
      'event_type=orca-fork-build',
      'client_payload[outcome]=published',
      `client_payload[sha]=${SHA}`,
      'client_payload[run]=42',
      `client_payload[tag]=${TAG}`
    ]) {
      expect(result.stdout).toContain(field)
    }
  })

  it('dispatches a failed or cancelled build without a tag', async () => {
    const failed = await run({ PUBLISHED: 'false' })
    expect(failed.stdout).toContain('client_payload[outcome]=failed')
    expect(failed.stdout).not.toContain('client_payload[tag]')
    const cancelled = await run({ CANCELLED: 'true' })
    expect(cancelled.stdout).toContain('client_payload[outcome]=cancelled')
  })

  it('leaves the build green without a token, and on a failed dispatch', async () => {
    const missing = await run({ GH_TOKEN: '' })
    expect(missing.exitCode).toBe(0)
    expect(missing.stdout).toContain('::notice::')
    expect(missing.stdout).not.toContain('dispatches')
    const failed = await run({ GH_FAILS: '1' })
    expect(failed.exitCode).toBe(0)
    expect(failed.stdout).toContain('::warning::')
  })
})
