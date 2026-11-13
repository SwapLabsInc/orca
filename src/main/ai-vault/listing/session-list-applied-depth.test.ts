import { describe, expect, it } from 'vitest'
import type { AiVaultListResult } from '../../../shared/ai-vault/contracts/ai-vault-types'
import { parseAiVaultListResult } from './session-list-result-validation'
import { mergeAiVaultListResults } from './session-list-results'

function legWithDepth(depth?: AiVaultListResult['appliedSessionDepth']): AiVaultListResult {
  return {
    sessions: [],
    issues: [],
    scannedAt: '2026-08-02T00:00:00.000Z',
    ...(depth === undefined ? {} : { appliedSessionDepth: depth })
  }
}

function validSession(sessionId = 'session-1'): Record<string, unknown> {
  return {
    id: `local:codex:${sessionId}:/tmp/${sessionId}.jsonl`,
    executionHostId: 'local',
    executionHostPlatform: 'linux',
    agent: 'codex',
    sessionId,
    title: 'Session one',
    cwd: '/repo',
    branch: null,
    model: null,
    filePath: `/tmp/${sessionId}.jsonl`,
    codexHome: null,
    createdAt: null,
    updatedAt: null,
    modifiedAt: '2026-07-27T00:00:00.000Z',
    messageCount: 1,
    totalTokens: 0,
    previewMessages: [],
    queuedMessageCount: 0,
    subagentTranscriptCount: 0,
    resumeCommand: `codex resume ${sessionId}`,
    subagent: null
  }
}

// EP-COMPAT: hosts and clients update independently, so both wire shapes have to survive this
// parser — it rebuilds the result field by field and would otherwise drop what it does not name.
describe('parsed scan coverage', () => {
  it('carries the depth a newer host says it applied', () => {
    const parsed = parseAiVaultListResult({
      sessions: [validSession()],
      issues: [],
      scannedAt: '2026-07-27T00:00:00.000Z',
      appliedSessionDepth: 'unlimited'
    })

    expect(parsed.appliedSessionDepth).toBe('unlimited')
  })

  it('leaves the applied depth absent for a host that predates the field', () => {
    const parsed = parseAiVaultListResult({
      sessions: [validSession()],
      issues: [],
      scannedAt: '2026-07-27T00:00:00.000Z'
    })

    expect(parsed.appliedSessionDepth).toBeUndefined()
  })

  // A value this build cannot read is no more provable than silence, so it degrades to absent
  // rather than to a number a reader would trust.
  it('drops a malformed applied depth instead of failing the whole result', () => {
    const parsed = parseAiVaultListResult({
      sessions: [validSession()],
      issues: [],
      scannedAt: '2026-07-27T00:00:00.000Z',
      appliedSessionDepth: 'most-of-them'
    })

    expect(parsed.sessions).toHaveLength(1)
    expect(parsed.appliedSessionDepth).toBeUndefined()
  })
})

describe('merged scan coverage', () => {
  it('reports unlimited only when the merge and every leg were uncapped', () => {
    const merged = mergeAiVaultListResults(
      [legWithDepth('unlimited'), legWithDepth('unlimited')],
      undefined,
      true
    )

    expect(merged.appliedSessionDepth).toBe('unlimited')
  })

  it('takes the tightest bound any leg applied', () => {
    const merged = mergeAiVaultListResults(
      [legWithDepth('unlimited'), legWithDepth(25)],
      undefined,
      true
    )

    expect(merged.appliedSessionDepth).toBe(25)
  })

  // One leg that cannot prove its coverage makes the merge unprovable: the rows it withheld are
  // exactly the ones missing here, and no other leg can vouch for them.
  it('reports nothing when a leg predates the signal', () => {
    const merged = mergeAiVaultListResults(
      [legWithDepth('unlimited'), legWithDepth()],
      undefined,
      true
    )

    expect(merged.appliedSessionDepth).toBeUndefined()
  })

  it('reports its own limit when the merge itself is the tighter bound', () => {
    const merged = mergeAiVaultListResults([legWithDepth('unlimited')], 10)

    expect(merged.appliedSessionDepth).toBe(10)
  })
})
