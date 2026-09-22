import type { AgentResumeCandidate } from '../../../shared/agent-resume-candidate'

/**
 * Panes whose resolver refused to decide and are showing the chooser.
 *
 * Deliberately not a store slice: this is transient per-pane UI state that never persists
 * and never crosses a host boundary, and keeping it out of the persisted session state means
 * a pending choice can never be written to disk and revived against a stale session list.
 */
const candidatesByPaneKey = new Map<string, readonly AgentResumeCandidate[]>()
const listenersByPaneKey = new Map<string, Set<() => void>>()

function notify(paneKey: string): void {
  for (const listener of listenersByPaneKey.get(paneKey) ?? []) {
    listener()
  }
}

export function setPendingAgentResumeChoices(
  paneKey: string,
  candidates: readonly AgentResumeCandidate[]
): void {
  if (candidates.length === 0) {
    clearPendingAgentResumeChoices(paneKey)
    return
  }
  candidatesByPaneKey.set(paneKey, candidates)
  notify(paneKey)
}

export function clearPendingAgentResumeChoices(paneKey: string): void {
  if (!candidatesByPaneKey.delete(paneKey)) {
    return
  }
  notify(paneKey)
}

/** Stable identity while unchanged, so `useSyncExternalStore` does not loop. */
export function getPendingAgentResumeChoices(
  paneKey: string
): readonly AgentResumeCandidate[] | undefined {
  return candidatesByPaneKey.get(paneKey)
}

export function subscribePendingAgentResumeChoices(paneKey: string, listener: () => void): () => void {
  const listeners = listenersByPaneKey.get(paneKey) ?? new Set<() => void>()
  listeners.add(listener)
  listenersByPaneKey.set(paneKey, listeners)
  return () => {
    const current = listenersByPaneKey.get(paneKey)
    if (!current) {
      return
    }
    current.delete(listener)
    if (current.size === 0) {
      listenersByPaneKey.delete(paneKey)
    }
  }
}

/** Test seam; production code clears per pane as choices are consumed or panes unmount. */
export function resetPendingAgentResumeChoices(): void {
  candidatesByPaneKey.clear()
  listenersByPaneKey.clear()
}
