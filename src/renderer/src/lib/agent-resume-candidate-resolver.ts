import {
  AGENT_RESUME_LIFETIME_SLACK_MS,
  AGENT_RESUME_SUBSTANCE_FLOOR_MESSAGES,
  type AgentResumeCandidate,
  type AgentResumeResolution
} from '../../../shared/agent-resume-candidate'
import {
  isResumableTuiAgent,
  normalizeAgentProviderSession,
  type ResumableTuiAgent
} from '../../../shared/agent-session-resume'

export type ResolveAgentResumeCandidateArgs = {
  candidates: readonly AgentResumeCandidate[]
  paneAgent: ResumableTuiAgent | null
  worktreePath: string
  tabLastSessionId?: string | null
  /** Host-clock epoch ms, comparable to candidate `updatedAt`; the caller owns that mapping. */
  tabCreatedAt?: number | null
  /** Host-clock epoch ms, comparable to candidate `updatedAt`; the caller owns that mapping. */
  tabLastSeenAt?: number | null
  claimedSessionIds: ReadonlySet<string>
}

/** Resolves which conversation a pane with no resume handle should resume. Refuses rather than
 *  guesses: resuming the wrong transcript forks it unrecoverably, while refusing costs only a
 *  bare shell. */
export function resolveAgentResumeCandidate(
  args: ResolveAgentResumeCandidateArgs
): AgentResumeResolution {
  const { paneAgent, worktreePath, claimedSessionIds } = args
  // Only a resumable identity counts; an id the shared parser would rewrite or reject cannot be
  // passed to getAgentResumeArgv as-is.
  const identified = args.candidates.filter(hasResumableIdentity)
  const idCounts = new Map<string, number>()
  for (const candidate of identified) {
    const id = candidate.providerSession.id
    idCounts.set(id, (idCounts.get(id) ?? 0) + 1)
  }

  const scoped = identified.filter(
    (candidate) =>
      (paneAgent === null || candidate.agent === paneAgent) &&
      worktreePath.length > 0 &&
      // Exact scope only: a prefix or basename match would pull in a sibling worktree.
      candidate.cwd === worktreePath
  )

  const survivors: AgentResumeCandidate[] = []
  let tainted = false
  let claimedSubstantial = 0
  for (const candidate of scoped) {
    const substance = readSubstance(candidate.messageCount)
    if (substance === 'thin') {
      continue
    }
    if (claimedSessionIds.has(candidate.providerSession.id)) {
      if (substance === 'substantial') {
        claimedSubstantial += 1
      }
      continue
    }
    // A contender whose evidence is corrupt or duplicated still exists; dropping it would let a
    // rival win by default, so its presence blocks every selection.
    if (
      substance === 'unknown' ||
      !isHostTimestamp(candidate.updatedAt) ||
      (idCounts.get(candidate.providerSession.id) ?? 0) > 1
    ) {
      tainted = true
      continue
    }
    survivors.push(candidate)
  }

  if (tainted) {
    return { kind: 'none', reason: 'ambiguous' }
  }
  if (survivors.length === 0) {
    return {
      kind: 'none',
      reason: claimedSubstantial > 0 ? 'every-candidate-claimed' : 'no-candidates'
    }
  }
  if (survivors.length === 1) {
    return { kind: 'resume', candidate: survivors[0], reason: 'sole-candidate' }
  }

  const tabSessionId = args.tabLastSessionId
  if (typeof tabSessionId === 'string' && tabSessionId.length > 0) {
    const matches = survivors.filter((candidate) => candidate.providerSession.id === tabSessionId)
    if (matches.length === 1) {
      return { kind: 'resume', candidate: matches[0], reason: 'tab-session-match' }
    }
  }

  const { tabCreatedAt, tabLastSeenAt } = args
  if (
    isHostTimestamp(tabCreatedAt) &&
    isHostTimestamp(tabLastSeenAt) &&
    tabCreatedAt <= tabLastSeenAt
  ) {
    // Both sides are host-clock values; a client clock would skew this window.
    const from = tabCreatedAt - AGENT_RESUME_LIFETIME_SLACK_MS
    const to = tabLastSeenAt + AGENT_RESUME_LIFETIME_SLACK_MS
    const inWindow = survivors.filter(
      (candidate) => candidate.updatedAt >= from && candidate.updatedAt <= to
    )
    if (inWindow.length === 1) {
      return { kind: 'resume', candidate: inWindow[0], reason: 'lifetime-window' }
    }
  }

  // Display order only; the user decides.
  const ranked = [...survivors].sort(
    (a, b) =>
      b.updatedAt - a.updatedAt ||
      (a.providerSession.id < b.providerSession.id
        ? -1
        : a.providerSession.id > b.providerSession.id
          ? 1
          : 0)
  )
  return { kind: 'choose', candidates: ranked }
}

function hasResumableIdentity(candidate: AgentResumeCandidate): boolean {
  return (
    isResumableTuiAgent(candidate.agent) &&
    typeof candidate.cwd === 'string' &&
    candidate.cwd.length > 0 &&
    normalizeAgentProviderSession(candidate.providerSession)?.id === candidate.providerSession.id
  )
}

function readSubstance(messageCount: number): 'thin' | 'substantial' | 'unknown' {
  if (!Number.isInteger(messageCount) || messageCount < 0) {
    return 'unknown'
  }
  return messageCount < AGENT_RESUME_SUBSTANCE_FLOOR_MESSAGES ? 'thin' : 'substantial'
}

function isHostTimestamp(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}
