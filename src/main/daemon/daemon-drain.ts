/* Draining a daemon launched from an older app bundle: its live sessions stay on it, reachable
   through a drain name, while a fresh daemon takes the canonical endpoint for new terminals. The
   old daemon sees its name lost and retires once its last session ends
   (daemon-endpoint-lifecycle.ts). Off unless ORCA_DAEMON_DRAIN_STALE_BUNDLE=1; see AGENTS.md. */
import { randomBytes } from 'node:crypto'
import { linkSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DaemonClient } from './client'
import {
  readDaemonEndpointEntryIdentity,
  type DaemonSocketIdentity
} from './daemon-endpoint-ownership'
import { endpointIsProvenDead, probeSocketConnect } from './daemon-endpoint-probe'
import { parseDaemonPidFile } from './daemon-pid-file-parse'
import { restoreClaimedDaemonArtifact } from './daemon-spawner'
import type { ListSessionsResult } from './types'

export const DAEMON_DRAIN_ENV = 'ORCA_DAEMON_DRAIN_STALE_BUNDLE'

/** The names a drained daemon stays reachable under. Every one is created by the app, never reused. */
export type DaemonDrainSlot = {
  protocolVersion: number
  socketPath: string
  tokenPath: string
  pidPath: string
}

export type DaemonDrainHandOver = {
  slot: DaemonDrainSlot
  /** The canonical entry handed over, which the fresh daemon may replace while it is still live. */
  incumbent: DaemonSocketIdentity
}

const DRAIN_SLOT_PATTERN = /^drain-v(\d+)-([0-9a-f]{8})\.sock$/
const DRAIN_VERIFY_TIMEOUT_MS = 2_000

/**
 * Windows is excluded: named pipes have no second name to keep the old daemon reachable under.
 * Anything but "1" is off; an unrecognised value says so rather than silently doing nothing.
 */
export function isDaemonDrainEnabled(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): boolean {
  const value = env[DAEMON_DRAIN_ENV]?.trim() ?? ''
  if (value !== '' && value !== '0' && value !== '1') {
    console.warn(
      `[daemon] Ignoring ${DAEMON_DRAIN_ENV}=${value}: use 1 to drain, 0 or unset not to`
    )
  }
  return value === '1' && platform !== 'win32'
}

function drainSlot(runtimeDir: string, protocolVersion: number, id: string): DaemonDrainSlot {
  const base = join(runtimeDir, `drain-v${protocolVersion}-${id}`)
  return {
    protocolVersion,
    socketPath: `${base}.sock`,
    tokenPath: `${base}.token`,
    pidPath: `${base}.pid`
  }
}

export function listDaemonDrainSlots(runtimeDir: string): DaemonDrainSlot[] {
  let names: string[]
  try {
    names = readdirSync(runtimeDir)
  } catch {
    return []
  }
  return names.flatMap((name) => {
    const match = DRAIN_SLOT_PATTERN.exec(name)
    return match ? [drainSlot(runtimeDir, Number(match[1]), match[2])] : []
  })
}

function sameEntry(a: DaemonSocketIdentity | null, b: DaemonSocketIdentity): boolean {
  return a !== null && a.dev === b.dev && a.ino === b.ino
}

function unlinkQuietly(path: string): void {
  try {
    unlinkSync(path)
  } catch {
    // Already gone, or never created.
  }
}

function removeSlot(slot: DaemonDrainSlot): void {
  for (const path of [slot.socketPath, slot.tokenPath, slot.pidPath]) {
    unlinkQuietly(path)
  }
}

async function answersThrough(slot: DaemonDrainSlot, protocolVersion: number): Promise<boolean> {
  const client = new DaemonClient({
    socketPath: slot.socketPath,
    tokenPath: slot.tokenPath,
    protocolVersion
  })
  try {
    await client.ensureConnectedWithin(DRAIN_VERIFY_TIMEOUT_MS)
    const listed = await client.request<ListSessionsResult>('listSessions', undefined)
    return Array.isArray(listed?.sessions)
  } catch {
    return false
  } finally {
    client.disconnect()
  }
}

function recordNames(content: string, pid: number, launchNonce: string | null): boolean {
  const parsed = parseDaemonPidFile(content)
  return parsed !== null && parsed.pid === pid && parsed.launchNonce === launchNonce
}

/**
 * Gives the verified, stale incumbent a drain name of its own and takes its token and PID record
 * with it, so a fresh daemon can publish and write its own. Null, with everything as it was,
 * whenever any step cannot be proven: the caller then preserves the incumbent as before.
 */
export async function prepareDaemonDrain(options: {
  runtimeDir: string
  socketPath: string
  tokenPath: string
  pidPath: string
  protocolVersion: number
  /** The incumbent the caller verified as stale: its record must still name it. */
  pid: number
  launchNonce: string | null
}): Promise<DaemonDrainHandOver | null> {
  const { runtimeDir, socketPath, tokenPath, pidPath, protocolVersion, pid, launchNonce } = options
  const incumbent = readDaemonEndpointEntryIdentity(socketPath)
  if (!incumbent) {
    return null
  }
  const slot = drainSlot(runtimeDir, protocolVersion, randomBytes(4).toString('hex'))
  try {
    // A second name for the same socket; `link` is exclusive, and the name is new, so it can
    // only ever be ours.
    linkSync(socketPath, slot.socketPath)
  } catch {
    return null
  }
  try {
    // The canonical name may have changed hands between the stat and the link.
    if (!sameEntry(readDaemonEndpointEntryIdentity(slot.socketPath), incumbent)) {
      removeSlot(slot)
      return null
    }
    writeFileSync(slot.tokenPath, readFileSync(tokenPath, 'utf8'), {
      mode: 0o600,
      flag: 'wx'
    })
    if (!(await answersThrough(slot, protocolVersion))) {
      removeSlot(slot)
      return null
    }
    // Moved, not copied: the fresh daemon publishes its record exclusively, and a record left
    // here would also be read as the fresh daemon's by everything that kills by PID.
    renameSync(pidPath, slot.pidPath)
  } catch {
    removeSlot(slot)
    return null
  }
  let record = ''
  try {
    record = readFileSync(slot.pidPath, 'utf8')
  } catch {
    // Unreadable is not the incumbent's.
  }
  if (!recordNames(record, pid, launchNonce)) {
    // Another incarnation's record: put it back and leave its daemon alone.
    restorePidRecord(slot, pidPath)
    removeSlot(slot)
    return null
  }
  return { slot, incumbent }
}

function restorePidRecord(slot: DaemonDrainSlot, pidPath: string): void {
  // Exclusive, so a record a fresh daemon has written since is never overwritten.
  restoreClaimedDaemonArtifact(slot.pidPath, pidPath)
}

/**
 * Takes back a hand-over the fresh daemon never completed: only while the incumbent still holds
 * the canonical name. Once it has lost it, the drain name is the only way to its sessions.
 */
export function abandonDaemonDrain(
  handOver: DaemonDrainHandOver,
  socketPath: string,
  pidPath: string
): boolean {
  if (!sameEntry(readDaemonEndpointEntryIdentity(socketPath), handOver.incumbent)) {
    return false
  }
  restorePidRecord(handOver.slot, pidPath)
  removeSlot(handOver.slot)
  return true
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM: alive, someone else's.
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * Removes a slot whose daemon is proven gone: nothing serving its name, and no record or a record
 * whose process is dead. The names are the app's own and never reused, so removing them cannot
 * reach another daemon's.
 */
export async function removeDeadDaemonDrainSlot(slot: DaemonDrainSlot): Promise<boolean> {
  if (!endpointIsProvenDead(await probeSocketConnect(slot.socketPath))) {
    return false
  }
  let content: string
  try {
    content = readFileSync(slot.pidPath, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      return false
    }
    content = ''
  }
  const parsed = content ? parseDaemonPidFile(content) : null
  if (content && !parsed) {
    return false
  }
  if (parsed && processAlive(parsed.pid)) {
    return false
  }
  removeSlot(slot)
  return true
}
