import { unlinkSync } from 'node:fs'
import {
  getDaemonHistoryDir as getHistoryDir,
  probeDaemonSocket as probeSocket
} from './daemon-launch-paths'
import { legacyDaemonProcessMayBeAlive } from './daemon-legacy-process-liveness'
import { DaemonPtyAdapter } from './daemon-pty-adapter'
import { getDaemonPidPath, getDaemonSocketPath, getDaemonTokenPath } from './daemon-spawner'
import {
  listDaemonDrainSlots,
  readDaemonDrainSlotIdentity,
  removeDeadDaemonDrainSlot
} from './daemon-drain'
import { readDaemonEndpointEntryIdentity } from './daemon-endpoint-ownership'
import { PREVIOUS_DAEMON_PROTOCOL_VERSIONS, PROTOCOL_VERSION } from './types'

// Isolated runtimes must keep discovery history outside app userData.
export async function createLegacyDaemonAdapters(
  runtimeDir: string,
  historyPath = getHistoryDir()
): Promise<DaemonPtyAdapter[]> {
  const adapters: DaemonPtyAdapter[] = []
  for (const protocolVersion of PREVIOUS_DAEMON_PROTOCOL_VERSIONS) {
    const socketPath = getDaemonSocketPath(runtimeDir, protocolVersion)
    const tokenPath = getDaemonTokenPath(runtimeDir, protocolVersion)
    if (!(await probeSocket(socketPath))) {
      // Keep records when the PID probe succeeds: a transient socket failure must not orphan live sessions.
      if (!legacyDaemonProcessMayBeAlive(runtimeDir, protocolVersion)) {
        for (const stalePath of [
          getDaemonPidPath(runtimeDir, protocolVersion),
          getDaemonTokenPath(runtimeDir, protocolVersion)
        ]) {
          try {
            unlinkSync(stalePath)
          } catch {
            // Stale-record cleanup must not block discovery.
          }
        }
      }
      continue
    }
    // Preserve old-protocol sessions without respawning into new code and environment semantics.
    // Cleanup history so a later protocol reusing the session ID cannot restore stale scrollback.
    adapters.push(
      new DaemonPtyAdapter({
        socketPath,
        tokenPath,
        pidPath: getDaemonPidPath(runtimeDir, protocolVersion),
        profileScope: runtimeDir,
        runtimeDir,
        protocolVersion,
        historyPath
      })
    )
  }
  return [...adapters, ...(await createDrainedDaemonAdapters(runtimeDir, historyPath))]
}

/**
 * Daemons drained for a newer bundle keep their live sessions until those end; like legacy ones
 * they never respawn. A slot whose daemon is proven gone is removed; one that cannot be classified
 * is left for the next launch, never dropped.
 */
async function createDrainedDaemonAdapters(
  runtimeDir: string,
  historyPath: string
): Promise<DaemonPtyAdapter[]> {
  const adapters: DaemonPtyAdapter[] = []
  // Why by inode: a name aliasing one already registered (the current endpoint, after a drain a
  // killed launch never finished, or another slot) is the same daemon, and registering it twice
  // would report every session twice and leave its owner unresolvable.
  const seen = [readDaemonEndpointEntryIdentity(getDaemonSocketPath(runtimeDir))]
  for (const slot of listDaemonDrainSlots(runtimeDir)) {
    const identity = readDaemonDrainSlotIdentity(slot)
    if (
      identity &&
      seen.some((other) => other?.dev === identity.dev && other.ino === identity.ino)
    ) {
      continue
    }
    const speaksProtocol =
      slot.protocolVersion === PROTOCOL_VERSION ||
      PREVIOUS_DAEMON_PROTOCOL_VERSIONS.some((version) => version === slot.protocolVersion)
    if (!speaksProtocol || !(await probeSocket(slot.socketPath))) {
      await removeDeadDaemonDrainSlot(slot)
      continue
    }
    adapters.push(
      new DaemonPtyAdapter({
        socketPath: slot.socketPath,
        tokenPath: slot.tokenPath,
        pidPath: slot.pidPath,
        profileScope: runtimeDir,
        runtimeDir,
        protocolVersion: slot.protocolVersion,
        historyPath,
        draining: true
      })
    )
    seen.push(identity)
  }
  return adapters
}
