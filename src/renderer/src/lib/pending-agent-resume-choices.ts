import type { AgentResumeCandidate } from '../../../shared/agent-resume-candidate'

/**
 * Panes whose resolver refused to decide and are showing the chooser.
 *
 * Deliberately not a store slice: this is transient per-pane UI state that never persists
 * and never crosses a host boundary, and keeping it out of the persisted session state means
 * a pending choice can never be written to disk and revived against a stale session list.
 *
 * Every choice carries the identity of the pty binding that scanned it. The pane key is stable
 * across a reconnect, so without that identity a chooser published for a retired connection
 * stayed on screen and reached the SUCCESSOR's handler — replacing a live shell with a session
 * scanned for a connection that no longer owns the pane.
 */
export type PendingAgentResumeChoice = {
  /** The pty binding these candidates were scanned for; nothing else may act on them. */
  owner: object
  candidates: readonly AgentResumeCandidate[]
}

const choiceByPaneKey = new Map<string, PendingAgentResumeChoice>()
const listenersByPaneKey = new Map<string, Set<() => void>>()

function notify(paneKey: string): void {
  for (const listener of listenersByPaneKey.get(paneKey) ?? []) {
    listener()
  }
}

export function setPendingAgentResumeChoices(
  paneKey: string,
  owner: object,
  candidates: readonly AgentResumeCandidate[]
): void {
  if (candidates.length === 0) {
    clearPendingAgentResumeChoices(paneKey)
    return
  }
  choiceByPaneKey.set(paneKey, { owner, candidates })
  notify(paneKey)
}

export function clearPendingAgentResumeChoices(paneKey: string): void {
  if (!choiceByPaneKey.delete(paneKey)) {
    return
  }
  notify(paneKey)
}

/** Dispose path: retire this binding's own choice and leave a successor's alone. */
export function clearPendingAgentResumeChoicesForOwner(paneKey: string, owner: object): void {
  if (choiceByPaneKey.get(paneKey)?.owner !== owner) {
    return
  }
  clearPendingAgentResumeChoices(paneKey)
}

/** Stable identity while unchanged, so `useSyncExternalStore` does not loop. */
export function getPendingAgentResumeChoices(
  paneKey: string
): PendingAgentResumeChoice | undefined {
  return choiceByPaneKey.get(paneKey)
}

export function subscribePendingAgentResumeChoices(
  paneKey: string,
  listener: () => void
): () => void {
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
  choiceByPaneKey.clear()
  listenersByPaneKey.clear()
}
