import { describe, expect, it } from 'vitest'
import type { AgentResumeCandidate } from '../../../../shared/agent-resume-candidate'
import { buildAgentResumeChooserRows } from './agent-resume-chooser-rows'

const HOST_NOW = 1_789_000_000_000

function makeCandidate(overrides: Partial<AgentResumeCandidate> = {}): AgentResumeCandidate {
  return {
    agent: 'claude',
    providerSession: { key: 'session_id', id: 'a521d69e-9181-481c-ab8e-998a1881b731' },
    cwd: '/w',
    title: 'Round 6',
    updatedAt: HOST_NOW,
    messageCount: 758,
    branch: null,
    executionHostId: null,
    ...overrides
  }
}

describe('buildAgentResumeChooserRows', () => {
  // `updatedAt` is the host's clock. Ages measured against the renderer's would be fiction
  // under skew, on the one surface where the user decides from exactly this evidence.
  it('ages every row against the newest candidate, not the renderer clock', () => {
    const rows = buildAgentResumeChooserRows([
      makeCandidate(),
      makeCandidate({
        providerSession: { key: 'session_id', id: 'b171319f-6711-4537-89be-00f26ccc7e32' },
        updatedAt: HOST_NOW - 3 * 60 * 60 * 1000
      })
    ])
    expect(rows.map((row) => row.age)).toEqual(['newest', '3h older'])
  })

  it('reads the same however far the host clock is from this one', () => {
    const skewed = buildAgentResumeChooserRows([
      makeCandidate({ updatedAt: Date.now() + 86_400_000 })
    ])
    expect(skewed[0].age).toBe('newest')
  })
})
