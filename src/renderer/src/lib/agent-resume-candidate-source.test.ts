import { describe, expect, it } from 'vitest'
import type { AiVaultSession } from '../../../shared/ai-vault-types'
import {
  fetchAgentResumeCandidates,
  toAgentResumeCandidate,
  toAgentResumeCandidates
} from './agent-resume-candidate-source'

const BASE_SESSION: AiVaultSession = {
  id: 'row-1',
  executionHostId: 'local',
  agent: 'claude',
  sessionId: 'c4c95ae3-fdd1-4ab6-be99-478dd26c3a67',
  title: 'Fix the ledger deadline',
  cwd: '/home/ubuntu/Desktop/qbit',
  branch: 'issue271',
  model: null,
  filePath: '/home/ubuntu/.claude/projects/x/y.jsonl',
  codexHome: null,
  createdAt: '2026-09-15T09:00:00.000Z',
  updatedAt: '2026-09-15T09:40:00.000Z',
  modifiedAt: '2026-09-15T09:41:00.000Z',
  messageCount: 758,
  totalTokens: 0,
  previewMessages: [],
  queuedMessageCount: 0,
  subagentTranscriptCount: 0,
  resumeCommand: 'claude --resume c4c95ae3-fdd1-4ab6-be99-478dd26c3a67',
  subagent: null
}

function session(overrides: Partial<AiVaultSession> = {}): AiVaultSession {
  return { ...BASE_SESSION, ...overrides }
}

describe('toAgentResumeCandidate', () => {
  it('maps an indexed session onto a candidate', () => {
    const candidate = toAgentResumeCandidate(session(), 'ssh:ssh-1')
    expect(candidate).toEqual({
      agent: 'claude',
      providerSession: { key: 'session_id', id: 'c4c95ae3-fdd1-4ab6-be99-478dd26c3a67' },
      cwd: '/home/ubuntu/Desktop/qbit',
      title: 'Fix the ledger deadline',
      updatedAt: Date.parse('2026-09-15T09:40:00.000Z'),
      messageCount: 758,
      branch: 'issue271',
      executionHostId: 'ssh:ssh-1'
    })
  })

  it('prefers the session updatedAt over the file mtime', () => {
    const candidate = toAgentResumeCandidate(session(), null)
    expect(candidate?.updatedAt).toBe(Date.parse('2026-09-15T09:40:00.000Z'))
  })

  it('falls back to the file mtime when updatedAt is absent', () => {
    const candidate = toAgentResumeCandidate(session({ updatedAt: null }), null)
    expect(candidate?.updatedAt).toBe(Date.parse('2026-09-15T09:41:00.000Z'))
  })

  // Why: the resolver must never select on a timestamp it cannot trust, and the host's
  // answer crosses a trust boundary, so the bad row is refused at the entry point.
  it('refuses a session whose timestamps are unparseable', () => {
    expect(toAgentResumeCandidate(session({ updatedAt: 'never', modifiedAt: '' }), null)).toBeNull()
  })

  it('refuses an agent Orca cannot resume', () => {
    expect(toAgentResumeCandidate(session({ agent: 'cursor' }), null)).toBeNull()
  })

  it('refuses a session with no cwd, because scope is what candidates are matched on', () => {
    expect(toAgentResumeCandidate(session({ cwd: null }), null)).toBeNull()
  })

  it('refuses a session id the shared parser would reject', () => {
    expect(toAgentResumeCandidate(session({ sessionId: '' }), null)).toBeNull()
    expect(toAgentResumeCandidate(session({ sessionId: '-leading-dash' }), null)).toBeNull()
  })

  it('drops unusable rows without discarding the usable ones beside them', () => {
    const candidates = toAgentResumeCandidates(
      [session(), session({ sessionId: '', id: 'row-2' }), session({ id: 'row-3' })],
      null
    )
    expect(candidates).toHaveLength(2)
  })
})

describe('fetchAgentResumeCandidates', () => {
  it('asks only the host that owns the transcripts, scoped to the workspace', async () => {
    const calls: unknown[] = []
    await fetchAgentResumeCandidates({
      worktreePath: '/home/ubuntu/Desktop/qbit',
      executionHostId: 'ssh:ssh-1',
      listSessions: async (request) => {
        calls.push(request)
        return { sessions: [session()] }
      }
    })
    expect(calls).toEqual([
      { scopePaths: ['/home/ubuntu/Desktop/qbit'], executionHostScope: 'ssh:ssh-1' }
    ])
  })

  // Why: loss of contact says nothing about the sessions. Answering empty leaves a plain
  // shell (the pre-feature behaviour) instead of risking a wrong resume.
  it('answers with no candidates when the host cannot be reached', async () => {
    const candidates = await fetchAgentResumeCandidates({
      worktreePath: '/home/ubuntu/Desktop/qbit',
      executionHostId: 'ssh:ssh-1',
      listSessions: async () => {
        throw new Error('relay unreachable')
      }
    })
    expect(candidates).toEqual([])
  })

  it('does not query at all without a workspace path', async () => {
    let queried = false
    const candidates = await fetchAgentResumeCandidates({
      worktreePath: '',
      executionHostId: null,
      listSessions: async () => {
        queried = true
        return { sessions: [] }
      }
    })
    expect(queried).toBe(false)
    expect(candidates).toEqual([])
  })
})
