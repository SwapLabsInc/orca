/**
 * Which pane has committed to respawning onto which conversation, in this renderer.
 *
 * Why a reservation and not the live claim set: a pane's claim only appears once its resumed
 * agent reports a status, seconds after the spawn. Two panes revealed together both finish
 * their host scan inside that window, so the claim set says "unclaimed" to both and they fork
 * one transcript. Reserving is synchronous, so exactly one of them can win.
 *
 * Renderer-scoped by design: it guards the panes this client is about to spawn. A session
 * already live somewhere else is excluded by the claim set the resolver reads.
 */
const paneKeyBySessionId = new Map<string, string>()

/** Check-and-reserve in one synchronous step; false means another pane got there first. */
export function reserveAgentResumeSession(sessionId: string, paneKey: string): boolean {
  const holder = paneKeyBySessionId.get(sessionId)
  if (holder !== undefined && holder !== paneKey) {
    return false
  }
  paneKeyBySessionId.set(sessionId, paneKey)
  return true
}

/** Session ids reserved by some other pane, which this pane must not be offered. */
export function agentResumeSessionsReservedElsewhere(paneKey: string): Set<string> {
  const reserved = new Set<string>()
  for (const [sessionId, holder] of paneKeyBySessionId) {
    if (holder !== paneKey) {
      reserved.add(sessionId)
    }
  }
  return reserved
}

/** Released on dispose: the pane that held the reservation no longer exists. */
export function releaseAgentResumeSessionsForPane(paneKey: string): void {
  const stale: string[] = []
  for (const [sessionId, holder] of paneKeyBySessionId) {
    if (holder === paneKey) {
      stale.push(sessionId)
    }
  }
  for (const sessionId of stale) {
    paneKeyBySessionId.delete(sessionId)
  }
}

/** Test seam. */
export function resetAgentResumeSessionReservations(): void {
  paneKeyBySessionId.clear()
}
