import { describe, expect, it } from 'vitest'
import { jobs, runWorkflowShell, stepNamed } from './swaplabs-build-workflow-shell.mjs'

// LOCAL: the fork build wakes SwapLabsInc/SwapLabs's devvms pin workflow once a
// release is live. The hourly schedule there is the fallback, so nothing here
// may fail the build.

const job = jobs['notify-devvms']
const step = stepNamed(job, 'Ask the devvms pin workflow to re-pin now')
const TAG = 'swaplabs-v1.4.215+202609281800'
// A stand-in gh that records its arguments and succeeds unless told to fail.
const mock = `gh() { printf '%s\\n' "$@" > "$RUNNER_TEMP/gh-args"; [[ "\${GH_FAILS:-}" != 1 ]]; }`
const run = (env) =>
  runWorkflowShell(`${step.run}\ncat "$RUNNER_TEMP/gh-args" 2>/dev/null`, {
    mock,
    env: { TAG, ...env }
  })

describe('swaplabs fork build wakes the devvms pin workflow', () => {
  it('runs only after a live publish, holding no GITHUB_TOKEN permission', () => {
    expect([job.needs].flat()).toEqual(expect.arrayContaining(['draft', 'publish']))
    expect(job.if).toBe("needs.publish.outputs.published == 'true'")
    expect(job.permissions).toEqual({})
    expect(step.env.GH_TOKEN).toBe('${{ secrets.SWAPLABS_DEVVMS_DISPATCH_TOKEN }}')
  })

  it('dispatches orca-fork-release with the published tag', async () => {
    const result = await run({ GH_TOKEN: 'token' })
    expect(result.exitCode, result.stderr).toBe(0)
    expect(result.stdout).toContain('repos/SwapLabsInc/SwapLabs/dispatches')
    expect(result.stdout).toContain('event_type=orca-fork-release')
    expect(result.stdout).toContain(`client_payload[tag]=${TAG}`)
  })

  it('leaves the build green without a token, and on a failed dispatch', async () => {
    const missing = await run({ GH_TOKEN: '' })
    expect(missing.exitCode).toBe(0)
    expect(missing.stdout).toContain('::notice::')
    expect(missing.stdout).not.toContain('dispatches')
    const failed = await run({ GH_TOKEN: 'token', GH_FAILS: '1' })
    expect(failed.exitCode).toBe(0)
    expect(failed.stdout).toContain('::warning::')
  })
})
