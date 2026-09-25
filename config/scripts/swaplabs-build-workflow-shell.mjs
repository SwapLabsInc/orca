import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse } from 'yaml'
import { runProcess } from '../../src/shared/child-process/run-process'

// LOCAL: what the fork build workflow's contract tests share — the parsed
// workflow, step lookups, and a runner that executes one step's bash against a
// mocked `gh` the way the hourly preflight test does, so the decision logic is
// exercised rather than eyeballed.

export const WORKFLOW_TEXT = readFileSync(
  new URL('../../.github/workflows/swaplabs-build.yml', import.meta.url),
  'utf8'
)
// Comments may name what is deliberately absent; only real references count.
export const WORKFLOW_CODE = WORKFLOW_TEXT.replace(/^\s*#.*$/gm, '')
export const workflow = parse(WORKFLOW_TEXT)
export const jobs = workflow.jobs
export const stepNamed = (job, name) => job.steps.find((step) => step.name === name)
export const stepIndex = (job, name) => job.steps.findIndex((step) => step.name === name)

export async function runWorkflowShell(script, { env = {}, mock }) {
  const directory = mkdtempSync(join(tmpdir(), 'swaplabs-workflow-'))
  const output = join(directory, 'output')
  const runnerTemp = join(directory, 'runner-temp')
  mkdirSync(runnerTemp)
  try {
    const result = await runProcess({
      program: 'bash',
      args: ['-c', `${mock}\n${script}`],
      env: {
        ...process.env,
        GITHUB_OUTPUT: output,
        RUNNER_TEMP: runnerTemp,
        GITHUB_REPOSITORY: 'SwapLabsInc/orca',
        FORK_BRANCH: 'swaplabs/main',
        UPSTREAM_REPO: 'stablyai/orca',
        SWAPLABS_TAG_PREFIX: 'swaplabs-v',
        SWAPLABS_RETAIN_COUNT: '30',
        ...env
      }
    })
    let outputText = ''
    try {
      outputText = readFileSync(output, 'utf8')
    } catch {
      outputText = ''
    }
    return {
      exitCode: result.code,
      stdout: result.stdout,
      stderr: result.stderr,
      output: outputText
    }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}
