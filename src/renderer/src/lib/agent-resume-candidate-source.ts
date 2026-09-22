import type { AgentResumeCandidate } from '../../../shared/agent-resume-candidate'
import type { AiVaultListResult, AiVaultSession } from '../../../shared/ai-vault-types'
import type { ExecutionHostId } from '../../../shared/execution-host'
import {
  extractAgentProviderSession,
  getAgentResumeArgv,
  isResumableTuiAgent,
  type AgentProviderSessionMetadata,
  type ResumableTuiAgent
} from '../../../shared/agent-session-resume'

/** Epoch ms from the host's ISO stamps, preferring the session's own `updatedAt` over the
 *  file mtime. Returns null rather than a guess: the resolver treats a bad timestamp as
 *  evidence it must not select on. */
/** Per-agent resume identity, read through the one mapping that already knows it. Antigravity
 *  resumes by conversation id and Pi/Prime Agent by transcript path, so a hardcoded `session_id`
 *  would name a locator those agents cannot resume. */
function readProviderSession(
  session: AiVaultSession,
  agent: ResumableTuiAgent
): AgentProviderSessionMetadata | null {
  const transcriptPath = typeof session.filePath === 'string' ? session.filePath.trim() : ''
  return extractAgentProviderSession(agent, {
    session_id: session.sessionId,
    sessionId: session.sessionId,
    sessionID: session.sessionId,
    conversationId: session.sessionId,
    ...(transcriptPath ? { transcript_path: transcriptPath, session_file: transcriptPath } : {})
  })
}

function readHostTimestamp(session: AiVaultSession): number | null {
  for (const raw of [session.updatedAt, session.modifiedAt]) {
    if (typeof raw !== 'string' || raw.length === 0) {
      continue
    }
    const parsed = Date.parse(raw)
    if (Number.isFinite(parsed) && parsed >= 0) {
      return parsed
    }
  }
  return null
}

/**
 * One indexed session -> one candidate, or null when the host's answer cannot support a
 * resume. The vault answer crosses a trust boundary (a remote host produced it), so every
 * field the resolver will act on is validated here at the entry point rather than deeper in.
 */
export function toAgentResumeCandidate(
  session: AiVaultSession,
  executionHostId: ExecutionHostId | null
): AgentResumeCandidate | null {
  if (!isResumableTuiAgent(session.agent)) {
    return null
  }
  const providerSession = readProviderSession(session, session.agent)
  if (!providerSession) {
    return null
  }
  // Refuse rather than offer: a candidate the resume argv builder cannot express would dismiss
  // the chooser and resume nothing.
  if (!getAgentResumeArgv(session.agent, providerSession)) {
    return null
  }
  const cwd = typeof session.cwd === 'string' ? session.cwd : ''
  if (cwd.length === 0) {
    return null
  }
  const updatedAt = readHostTimestamp(session)
  if (updatedAt === null) {
    return null
  }
  return {
    agent: session.agent,
    providerSession,
    cwd,
    title: typeof session.title === 'string' ? session.title : '',
    updatedAt,
    messageCount: session.messageCount,
    branch: typeof session.branch === 'string' ? session.branch : null,
    executionHostId
  }
}

export function toAgentResumeCandidates(
  sessions: readonly AiVaultSession[],
  executionHostId: ExecutionHostId | null
): AgentResumeCandidate[] {
  const candidates: AgentResumeCandidate[] = []
  for (const session of sessions) {
    const candidate = toAgentResumeCandidate(session, executionHostId)
    if (candidate) {
      candidates.push(candidate)
    }
  }
  return candidates
}

/** A scan that answered for the whole scope, or one whose answer may be a subset.
 *  `unverifiable` is never "no candidates": an incomplete scan says nothing about what the host
 *  holds, so resuming its subset could fork the wrong transcript
 *  (docs/reference/ssh-execution-boundary.md). */
export type AgentResumeCandidateScan =
  | { kind: 'complete'; candidates: AgentResumeCandidate[] }
  | { kind: 'unverifiable'; reason: 'cancelled' | 'scan-issues' | 'no-contact' }

/** True only for an answer that covered the scope. `cancelled` is an empty body by construction,
 *  and any non-notice issue means some path or host the scan needed went unread — `notice` rows
 *  are scanner commentary the shared type documents as never a failure. */
function scanIncompleteReason(
  result: Pick<AiVaultListResult, 'issues' | 'cancelled'>
): 'cancelled' | 'scan-issues' | null {
  if (result.cancelled === true) {
    return 'cancelled'
  }
  const failures = (result.issues ?? []).filter((issue) => issue.kind !== 'notice')
  return failures.length > 0 ? 'scan-issues' : null
}

/**
 * Asks the pane's execution host which sessions it holds for this workspace.
 *
 * Addresses exactly one host — the one that owns the transcripts — because a session id
 * names a transcript on the machine that captured it. A failure, a cancellation and a partial
 * scan all answer `unverifiable`: the caller then leaves a plain shell, which is the pre-feature
 * behaviour, and never a wrong resume.
 */
export async function fetchAgentResumeCandidates(args: {
  worktreePath: string
  executionHostId: ExecutionHostId | null
  listSessions: (request: {
    scopePaths: readonly string[]
    executionHostScope?: ExecutionHostId
  }) => Promise<Pick<AiVaultListResult, 'sessions' | 'issues' | 'cancelled'>>
}): Promise<AgentResumeCandidateScan> {
  if (args.worktreePath.length === 0) {
    return { kind: 'complete', candidates: [] }
  }
  try {
    const result = await args.listSessions({
      scopePaths: [args.worktreePath],
      ...(args.executionHostId ? { executionHostScope: args.executionHostId } : {})
    })
    const incomplete = scanIncompleteReason(result)
    if (incomplete) {
      return { kind: 'unverifiable', reason: incomplete }
    }
    return {
      kind: 'complete',
      candidates: toAgentResumeCandidates(result.sessions ?? [], args.executionHostId)
    }
  } catch {
    // Loss of contact is not evidence about the sessions; it only means we cannot offer one.
    return { kind: 'unverifiable', reason: 'no-contact' }
  }
}
