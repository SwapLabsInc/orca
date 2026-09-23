import { describe, expect, it } from 'vitest'
import type {
  AgentResumeCandidate,
  AgentResumeResolution
} from '../../../shared/agent-resume-candidate'
import { decideAgentResumeForPane, type AgentResumePaneInputs } from './agent-resume-pane-decision'

const candidate: AgentResumeCandidate = {
  agent: 'claude',
  providerSession: { key: 'session_id', id: 'a521d69e-9181-481c-ab8e-998a1881b731' },
  cwd: '/home/ubuntu/Desktop/qbit',
  title: 'Round 6',
  updatedAt: 1_789_000_000_000,
  messageCount: 758,
  branch: null,
  executionHostId: 'ssh:ssh-1',
  executionHostPlatform: null
}

const resumeResolution: AgentResumeResolution = {
  kind: 'resume',
  candidate,
  reason: 'sole-candidate'
}

function inputs(overrides: Partial<AgentResumePaneInputs> = {}): AgentResumePaneInputs {
  return {
    paneHasOwnRecord: false,
    paneIsVisible: true,
    paneHasReceivedInput: false,
    resolution: resumeResolution,
    ...overrides
  }
}

describe('decideAgentResumeForPane', () => {
  it('resumes a visible, untouched pane the resolver decided for', () => {
    expect(decideAgentResumeForPane(inputs())).toEqual({ kind: 'resume', candidate })
  })

  it('offers the choice when the resolver refused to decide', () => {
    const resolution: AgentResumeResolution = { kind: 'choose', candidates: [candidate] }
    expect(decideAgentResumeForPane(inputs({ resolution }))).toEqual({
      kind: 'choose',
      candidates: [candidate]
    })
  })

  // Why: the synchronous cold-restore path already resumes that record. Acting here too
  // would put two panes on one transcript, which forks it unrecoverably.
  it('stands down when the pane has its own record', () => {
    expect(decideAgentResumeForPane(inputs({ paneHasOwnRecord: true }))).toEqual({
      kind: 'none',
      reason: 'pane-owns-record'
    })
  })

  // Why: panes mount hidden and in bulk. After a host restart this must not respawn a whole
  // workspace at once, nor queue a chooser behind every hidden tab.
  it('stands down on a hidden pane', () => {
    expect(decideAgentResumeForPane(inputs({ paneIsVisible: false }))).toEqual({
      kind: 'none',
      reason: 'pane-hidden'
    })
  })

  // Why: respawning replaces the shell. Once the user has typed, the shell is theirs.
  it('stands down once the user has typed into the shell', () => {
    expect(decideAgentResumeForPane(inputs({ paneHasReceivedInput: true }))).toEqual({
      kind: 'none',
      reason: 'pane-in-use'
    })
  })

  it('stands down when the resolver found nothing', () => {
    const resolution: AgentResumeResolution = { kind: 'none', reason: 'no-candidates' }
    expect(decideAgentResumeForPane(inputs({ resolution }))).toEqual({
      kind: 'none',
      reason: 'resolver-refused'
    })
  })

  it('checks the destructive gates before the resolver verdict', () => {
    const decision = decideAgentResumeForPane(
      inputs({ paneHasReceivedInput: true, paneIsVisible: false })
    )
    // Hidden is checked first; either refusal is correct, but it must never resume.
    expect(decision.kind).toBe('none')
  })
})
