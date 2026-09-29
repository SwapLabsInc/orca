import type { DaemonSocketIdentity } from './daemon-endpoint-ownership'
import type { DaemonFileLog } from './daemon-file-log'
import type { SubprocessHandle } from './session-subprocess-handle'

export type DaemonServerOptions = {
  socketPath: string
  tokenPath: string
  pidPath?: string
  launchNonce?: string
  startedAtMs?: number
  publishEndpointOwnership?: () => void
  /** A live incumbent the launcher handed the endpoint over from; see publishDaemonEndpoint. */
  handedOverEndpoint?: DaemonSocketIdentity
  entryPath?: string
  appVersion?: string
  spawnerExecPath?: string
  protocolVersion?: number
  onIdleShutdown?: () => void
  onRpcShutdown?: () => void
  initialAdoptionTestConfig?: {
    timeoutMs: number
    clock: {
      setTimeout(callback: () => void, delayMs: number): unknown
      clearTimeout(handle: unknown): void
      now(): number
    }
  }
  ptySpawnHealthCheck?: () => Promise<void>
  preparePtySpawn?: () => Promise<void>
  onPtySessionExit?: (sessionId: string) => void
  onAuthenticatedClientPair?: () => void
  log?: DaemonFileLog
  spawnSubprocess: (opts: {
    sessionId: string
    cols: number
    rows: number
    cwd?: string
    env?: Record<string, string>
    command?: string
    shellOverride?: string
    isCanceled?: () => boolean
  }) => SubprocessHandle | Promise<SubprocessHandle>
}
