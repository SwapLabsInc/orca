import type { PtySpawnOptions, PtySpawnResult } from '../providers/pty-provider-contract'
import { SessionNotFoundError } from './daemon-errors'
import type { DaemonPtyAdapter } from './daemon-pty-adapter'
import { routeSpawnOrHold } from './daemon-router-newer-daemon-hold'
import type { DaemonSessionOwnerResolver } from './daemon-session-owner-resolution'

/**
 * Spawns on the adapter the router chose. A drained daemon (daemon-drain.ts) refuses to create, so
 * a create-or-attach routed to it is sent attach-only; once the session is proven absent, the
 * create is routed like any unrouted id. An owner that cannot be established still throws, so the
 * session is never started twice. A null owner means the attach already recorded its route.
 */
export async function spawnDrainSafe(
  opts: PtySpawnOptions,
  target: DaemonPtyAdapter,
  current: DaemonPtyAdapter,
  ownerResolver: DaemonSessionOwnerResolver<DaemonPtyAdapter>
): Promise<{ result: PtySpawnResult; owner: DaemonPtyAdapter | null }> {
  const { sessionId } = opts
  if (!target.draining || !sessionId) {
    return { result: await target.spawn(opts), owner: target }
  }
  try {
    const attached = await ownerResolver.spawnAttachOnly({ ...opts, sessionId, attachOnly: true })
    return { result: attached, owner: null }
  } catch (error) {
    if (!(error instanceof SessionNotFoundError)) {
      throw error
    }
    ownerResolver.forgetRoute(sessionId, target)
  }
  const owner = await routeSpawnOrHold(opts, undefined, current, ownerResolver)
  return { result: await owner.spawn(opts), owner }
}
