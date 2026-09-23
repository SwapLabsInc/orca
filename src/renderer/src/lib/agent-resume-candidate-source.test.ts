import { describe, expect, it, vi } from 'vitest'
import {
  AI_VAULT_SCAN_ISSUE_LIMIT,
  type AiVaultScanIssue,
  type AiVaultSession
} from '../../../shared/ai-vault-types'
import { DEFAULT_AI_VAULT_SCAN_LIMIT } from '../../../shared/ai-vault-session-depth'

/** A host that honoured the uncapped request: the ordinary healthy answer. */
const UNCAPPED = { appliedSessionDepth: 'unlimited' } as const
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
      providerSession: {
        key: 'session_id',
        id: 'c4c95ae3-fdd1-4ab6-be99-478dd26c3a67',
        transcriptPath: '/home/ubuntu/.claude/projects/x/y.jsonl'
      },
      cwd: '/home/ubuntu/Desktop/qbit',
      title: 'Fix the ledger deadline',
      updatedAt: Date.parse('2026-09-15T09:40:00.000Z'),
      messageCount: 758,
      branch: 'issue271',
      executionHostId: 'ssh:ssh-1',
      executionHostPlatform: null
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

  // Hardcoding `session_id` for every agent made Antigravity's candidate unusable: it passes
  // isResumableTuiAgent, so it reached the chooser and then produced no resume argv at all.
  it('reads Antigravity by conversation id', () => {
    const candidate = toAgentResumeCandidate(session({ agent: 'antigravity' }), null)
    expect(candidate?.providerSession).toEqual({
      key: 'conversation_id',
      id: 'c4c95ae3-fdd1-4ab6-be99-478dd26c3a67'
    })
  })

  it('carries the transcript path the path-resuming agents need', () => {
    const candidate = toAgentResumeCandidate(session({ agent: 'pi' }), null)
    expect(candidate?.providerSession.transcriptPath).toBe(
      '/home/ubuntu/.claude/projects/x/y.jsonl'
    )
  })

  // A candidate that cannot produce resume argv must never be offered: the chooser would
  // dismiss itself and resume nothing.
  it('refuses a path-resuming agent whose row has no transcript path', () => {
    expect(toAgentResumeCandidate(session({ agent: 'pi', filePath: '' }), null)).toBeNull()
    expect(toAgentResumeCandidate(session({ agent: 'prime-agent', filePath: '' }), null)).toBeNull()
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
        return { sessions: [session()], issues: [], scannedAt: '', ...UNCAPPED }
      }
    })
    expect(calls).toEqual([
      {
        scopePaths: ['/home/ubuntu/Desktop/qbit'],
        executionHostScope: 'ssh:ssh-1',
        unlimited: true
      }
    ])
  })

  // Why not "no candidates": loss of contact says nothing about the sessions, and a scan that
  // answered about nothing must not let a subset be read as the sole candidate.
  it('answers unverifiable when the host cannot be reached', async () => {
    const scan = await fetchAgentResumeCandidates({
      worktreePath: '/home/ubuntu/Desktop/qbit',
      executionHostId: 'ssh:ssh-1',
      listSessions: async () => {
        throw new Error('relay unreachable')
      }
    })
    expect(scan).toEqual({ kind: 'unverifiable', reason: 'no-contact' })
  })

  // A cancelled scan resolves with an empty body by construction, which is the shape most
  // likely to be misread as "this host holds nothing".
  it('answers unverifiable for a cancelled scan', async () => {
    const scan = await fetchAgentResumeCandidates({
      worktreePath: '/home/ubuntu/Desktop/qbit',
      executionHostId: 'ssh:ssh-1',
      listSessions: async () => ({ sessions: [], issues: [], scannedAt: '', cancelled: true })
    })
    expect(scan).toEqual({ kind: 'unverifiable', reason: 'cancelled' })
  })

  it('answers unverifiable when the scan reports an unread path or host', async () => {
    const scan = await fetchAgentResumeCandidates({
      worktreePath: '/home/ubuntu/Desktop/qbit',
      executionHostId: 'ssh:ssh-1',
      listSessions: async () => ({
        sessions: [session()],
        issues: [{ agent: 'claude', kind: 'host', path: '/home', message: 'host unreachable' }],
        scannedAt: ''
      })
    })
    expect(scan).toEqual({ kind: 'unverifiable', reason: 'scan-issues' })
  })

  // A lone notice is per-transcript commentary (a transcript with skipped records), and the scan
  // that produced it still covered its scope.
  it('treats a short notice-only issue list as a complete scan', async () => {
    const scan = await fetchAgentResumeCandidates({
      worktreePath: '/home/ubuntu/Desktop/qbit',
      executionHostId: 'ssh:ssh-1',
      listSessions: async () => ({
        sessions: [session()],
        issues: [{ agent: 'claude', kind: 'notice', path: '', message: 'records were skipped' }],
        scannedAt: '',
        ...UNCAPPED
      })
    })
    expect(scan.kind).toBe('complete')
  })

  // The opposite reading of the same kind: a list AT the cap is one `recordSessionScanIssue`
  // stopped appending to, so the rows that did not fit are gone. A stalled WSL distro records one
  // refusal per discovered path, and only the overflow notice survives filtering — reading that as
  // a clean scan lets the surviving subset be auto-resumed as a sole candidate.
  it('refuses a scan whose issue list hit the cap, even when every surviving row is a notice', async () => {
    const issues: AiVaultScanIssue[] = Array.from(
      { length: AI_VAULT_SCAN_ISSUE_LIMIT },
      (_, index) => ({
        agent: 'claude',
        kind: 'notice',
        path: `/w/${index}`,
        message: 'Additional scan issues were omitted.'
      })
    )
    const scan = await fetchAgentResumeCandidates({
      worktreePath: '/home/ubuntu/Desktop/qbit',
      executionHostId: 'ssh:ssh-1',
      listSessions: async () => ({ sessions: [session()], issues, scannedAt: '', ...UNCAPPED })
    })
    expect(scan).toEqual({ kind: 'unverifiable', reason: 'scan-issues' })
  })

  it('does not query at all without a workspace path', async () => {
    let queried = false
    const scan = await fetchAgentResumeCandidates({
      worktreePath: '',
      executionHostId: null,
      listSessions: async () => {
        queried = true
        return { sessions: [], issues: [], scannedAt: '', ...UNCAPPED }
      }
    })
    expect(queried).toBe(false)
    expect(scan).toEqual({ kind: 'complete', candidates: [] })
  })
})

describe('scan completeness', () => {
  it('asks the host for an uncapped scan', async () => {
    const listSessions = vi.fn().mockResolvedValue({ sessions: [], issues: [] })
    await fetchAgentResumeCandidates({
      worktreePath: '/srv/wt',
      executionHostId: 'ssh:ssh-1',
      listSessions
    })
    expect(listSessions).toHaveBeenCalledWith({
      scopePaths: ['/srv/wt'],
      executionHostScope: 'ssh:ssh-1',
      unlimited: true
    })
  })

  it('accepts a 1000-session answer the host honoured uncapped', async () => {
    // This PR's own motivating machine. The old row-count heuristic called it truncated forever,
    // disabling auto-resume on exactly the hosts that accumulate the most transcripts.
    const sessions = Array.from({ length: DEFAULT_AI_VAULT_SCAN_LIMIT }, (_, index) =>
      session({ id: `row-${index}`, sessionId: `c4c95ae3-fdd1-4ab6-be99-478dd26c3a${index}` })
    )
    const scan = await fetchAgentResumeCandidates({
      worktreePath: '/srv/wt',
      executionHostId: null,
      listSessions: vi.fn().mockResolvedValue({ sessions, issues: [], ...UNCAPPED })
    })
    expect(scan.kind).toBe('complete')
  })

  it('refuses an answer from a host that never says what depth it applied', async () => {
    // A host older than the signal. Its silence is not proof it honoured `unlimited`, and a host
    // capping BELOW the default was invisible to the old row-count check entirely.
    const scan = await fetchAgentResumeCandidates({
      worktreePath: '/srv/wt',
      executionHostId: null,
      listSessions: vi.fn().mockResolvedValue({ sessions: [session()], issues: [] })
    })
    expect(scan).toEqual({ kind: 'unverifiable', reason: 'scan-truncated' })
  })

  it('refuses an answer that filled the depth its host applied, however small', async () => {
    const sessions = [
      session(),
      session({ id: 'row-2', sessionId: 'c4c95ae3-fdd1-4ab6-be99-478dd26c3a68' })
    ]
    const scan = await fetchAgentResumeCandidates({
      worktreePath: '/srv/wt',
      executionHostId: null,
      listSessions: vi
        .fn()
        .mockResolvedValue({ sessions, issues: [], appliedSessionDepth: sessions.length })
    })
    expect(scan).toEqual({ kind: 'unverifiable', reason: 'scan-truncated' })
  })

  it('accepts an answer that did not fill the depth its host applied', async () => {
    const scan = await fetchAgentResumeCandidates({
      worktreePath: '/srv/wt',
      executionHostId: null,
      listSessions: vi
        .fn()
        .mockResolvedValue({ sessions: [session()], issues: [], appliedSessionDepth: 50 })
    })
    expect(scan.kind).toBe('complete')
  })
})
