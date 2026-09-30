import { describe, expect, it, vi } from 'vitest'
import type { TerminalLossAgentResume } from '../agent-hooks/server'
import { HostPaneAgentResumes, type HostPaneAgentResumeInputs } from './host-pane-agent-resume'

const RESUME: TerminalLossAgentResume = {
  agent: 'claude',
  providerSession: { key: 'session_id', id: 'c0ffee00-0000-4000-8000-000000000001' }
}

function inputs(overrides: Partial<HostPaneAgentResumeInputs> = {}): HostPaneAgentResumeInputs {
  return {
    selectResume: () => RESUME,
    getSettings: () => ({
      agentCmdOverrides: {},
      agentDefaultArgs: { claude: '--dangerously-skip-permissions --model opus --effort max' },
      agentDefaultEnv: { claude: { CLAUDE_TEST_ENV: '1' } },
      disabledTuiAgents: []
    }),
    resolveWorkspace: async () => ({ connectionId: null, platform: 'linux' }),
    isStillPending: () => true,
    ...overrides
  }
}

describe('HostPaneAgentResumes', () => {
  it("builds the resume from the host's own launch settings", async () => {
    const prepared = await new HostPaneAgentResumes().prepare(inputs())

    expect(prepared?.launch).toMatchObject({
      agent: 'claude',
      providerSession: RESUME.providerSession,
      env: { CLAUDE_TEST_ENV: '1' }
    })
    expect(prepared?.launch.command).toBe(
      "claude '--dangerously-skip-permissions' '--model' 'opus' '--effort' 'max' '--resume' 'c0ffee00-0000-4000-8000-000000000001'"
    )
  })

  it('opens a plain shell for a disabled agent or an SSH workspace', async () => {
    const resumes = new HostPaneAgentResumes()
    expect(
      await resumes.prepare(inputs({ getSettings: () => ({ disabledTuiAgents: ['claude'] }) }))
    ).toBeNull()
    expect(
      await resumes.prepare(
        inputs({
          resolveWorkspace: async () => ({ connectionId: 'ssh-1', platform: 'linux' })
        })
      )
    ).toBeNull()
  })

  it('opens a plain shell when the launch cannot be prepared', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const prepared = await new HostPaneAgentResumes().prepare(
      inputs({
        resolveWorkspace: async () => {
          throw new Error('workspace not found')
        }
      })
    )
    expect(prepared).toBeNull()
    warn.mockRestore()
  })

  it('revalidates the pane and its session after the awaits that prepared the launch', async () => {
    const resumes = new HostPaneAgentResumes()
    expect(await resumes.prepare(inputs({ isStillPending: () => false }))).toBeNull()

    let reads = 0
    const moved = await resumes.prepare(
      inputs({
        selectResume: () =>
          reads++ === 0
            ? RESUME
            : { agent: 'claude', providerSession: { key: 'session_id', id: 'another-session' } }
      })
    )
    expect(moved).toBeNull()
  })

  it('lets only one re-creation resume a session until it settles', async () => {
    const resumes = new HostPaneAgentResumes()
    const first = await resumes.prepare(inputs())
    expect(first).not.toBeNull()
    expect(await resumes.prepare(inputs())).toBeNull()

    first!.release()
    expect(await resumes.prepare(inputs())).not.toBeNull()
  })

  it('claims Pi sessions by their transcript, so two sharing an id both resume', async () => {
    const resumes = new HostPaneAgentResumes()
    const pi = (transcriptPath: string): TerminalLossAgentResume => ({
      agent: 'pi',
      providerSession: { key: 'session_id', id: 'shared-id', transcriptPath }
    })
    const first = await resumes.prepare(inputs({ selectResume: () => pi('/s/a.jsonl') }))
    expect(first).not.toBeNull()
    expect(await resumes.prepare(inputs({ selectResume: () => pi('/s/b.jsonl') }))).not.toBeNull()
    expect(await resumes.prepare(inputs({ selectResume: () => pi('/s/a.jsonl') }))).toBeNull()
  })

  it('shares one in-flight re-creation per pane and forgets it once settled', async () => {
    const resumes = new HostPaneAgentResumes()
    let settle!: () => void
    const materialization = resumes.track(
      'pane-1',
      new Promise<void>((resolve) => (settle = resolve))
    )
    expect(resumes.inFlight('pane-1')).toBe(materialization)
    expect(resumes.inFlight('pane-2')).toBeUndefined()

    settle()
    await materialization
    await Promise.resolve()
    expect(resumes.inFlight('pane-1')).toBeUndefined()
  })
})
