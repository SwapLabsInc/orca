import type { AgentResumeCandidate } from '../../../../shared/agent-resume-candidate'
import { AI_VAULT_AGENT_LABELS } from '../../../../shared/ai-vault-types'

/** How many candidates the chooser offers. Past this the list stops being a glance
 *  and the AI Vault sidebar is the better surface. */
export const AGENT_RESUME_CHOOSER_MAX_ROWS = 5

/** Reuses the vault's label map so one agent reads the same everywhere; an agent the
 *  vault does not label (it indexes a different set) falls back to its own id. */
export function agentResumeChooserAgentLabel(agent: string): string {
  const labels: Record<string, string> = AI_VAULT_AGENT_LABELS
  return labels[agent] ?? agent
}

/** Ages are relative to the newest candidate, never to the renderer clock: `updatedAt` is the
 *  HOST's clock, and under skew a "2h ago" computed here would be fiction on the surface where
 *  the user is choosing on exactly that evidence. Candidate-to-candidate distance is skew-free
 *  because both sides come from the same host clock. */
export function agentResumeChooserRelativeAge(updatedAt: number, newestUpdatedAt: number): string {
  if (!Number.isFinite(updatedAt) || !Number.isFinite(newestUpdatedAt)) {
    return 'unknown'
  }
  const minutes = Math.floor(Math.max(0, newestUpdatedAt - updatedAt) / 60_000)
  if (minutes < 1) {
    return 'newest'
  }
  if (minutes < 60) {
    return `${minutes}m older`
  }
  const hours = Math.floor(minutes / 60)
  if (hours < 24) {
    return `${hours}h older`
  }
  return `${Math.floor(hours / 24)}d older`
}

export type AgentResumeChooserRow = {
  candidate: AgentResumeCandidate
  agentLabel: string
  title: string
  age: string
  messageCount: number
  branch: string | null
}

/** Ranking is display order only — the resolver already refused to decide, so nothing
 *  here may be read as a recommendation. */
export function buildAgentResumeChooserRows(
  candidates: readonly AgentResumeCandidate[]
): AgentResumeChooserRow[] {
  const newestUpdatedAt = candidates.reduce(
    (newest, candidate) => (candidate.updatedAt > newest ? candidate.updatedAt : newest),
    Number.NEGATIVE_INFINITY
  )
  return candidates.slice(0, AGENT_RESUME_CHOOSER_MAX_ROWS).map((candidate) => ({
    candidate,
    agentLabel: agentResumeChooserAgentLabel(candidate.agent),
    title: candidate.title.trim() || candidate.providerSession.id,
    age: agentResumeChooserRelativeAge(candidate.updatedAt, newestUpdatedAt),
    messageCount: Math.max(0, Math.trunc(candidate.messageCount)),
    branch: candidate.branch
  }))
}
