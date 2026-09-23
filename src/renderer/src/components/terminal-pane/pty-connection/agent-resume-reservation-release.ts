import { releaseAgentResumeSessionsForPane } from '@/lib/agent-resume-session-reservations'
import type { ConnectPanePtySession } from './connect-pane-pty-session'

/**
 * Hands a retired binding's resume reservation back, once it is safe to.
 *
 * Two things make "now" wrong. A successor may already own the stable pane key, and releasing
 * its reservation would reopen the fork window. And a reservation whose spawn is still settling
 * has no claim yet, so releasing it leaves a sibling pane free to reserve and respawn the same
 * transcript — the fork the reservation map exists to prevent. The owner is therefore re-read at
 * release time rather than at dispose time, because a deferred release can land after the slot
 * changed hands.
 */
export function releaseAgentResumeReservationOnDispose(session: ConnectPanePtySession): void {
  const releaseWhenOwned = (): void => {
    const owner = session.deps.paneTransportsRef.current.get(session.pane.id)
    if (!owner || owner === session.transport) {
      releaseAgentResumeSessionsForPane(session.cacheKey)
    }
  }
  const inFlight = session.agentResumeSpawnInFlight
  if (inFlight) {
    void inFlight.then(releaseWhenOwned, releaseWhenOwned)
    return
  }
  releaseWhenOwned()
}
