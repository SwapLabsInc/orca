import {
  AGENT_RESUME_SUBSTANCE_FLOOR_MESSAGES,
  type AgentResumeCandidate,
  type AgentResumeResolution
} from '../../../shared/agent-resume-candidate'
import {
  isResumableTuiAgent,
  normalizeAgentProviderSession,
  type ResumableTuiAgent
} from '../../../shared/agent-session-resume'
import { normalizeRuntimePathForComparison } from '../../../shared/cross-platform-path'

export type ResolveAgentResumeCandidateArgs = {
  candidates: readonly AgentResumeCandidate[]
  paneAgent: ResumableTuiAgent | null
  worktreePath: string
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

  // Compared as normalized keys on BOTH sides, through the same normalizer the vault's own scope
  // machinery uses: raw equality false-negatives on `C:\\repo` vs `C:/repo`, drive-letter casing,
  // a trailing separator, and macOS NFD against an agent's NFC cwd. Still EQUALITY, not containment
  // — a sibling worktree or the repo root must keep missing, which is what scopes the resume.
  const scopeKey = worktreePath.length > 0 ? normalizeRuntimePathForComparison(worktreePath) : null
  const scoped = identified.filter(
    (candidate) =>
      (paneAgent === null || candidate.agent === paneAgent) &&
      scopeKey !== null &&
      normalizeRuntimePathForComparison(candidate.cwd) === scopeKey
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

  // Why no tab-session-match or lifetime-window rung: the renderer cannot source either. A tab
  // carries no last provider session id — that handle is precisely what was lost — and its
  // `createdAt` is a renderer-clock value, which this resolver may never compare to a host-clock
  // `updatedAt`. Guessing across those clocks forks a transcript; the chooser asks instead.
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
