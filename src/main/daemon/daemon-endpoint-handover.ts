import { parseHandedOverEndpoint, type DaemonSocketIdentity } from './daemon-endpoint-ownership'
import type { DaemonServerOptions } from './daemon-server-options'

/**
 * A draining launch's `--handed-over-endpoint` (daemon-drain.ts). Read beside upstream's
 * parseArgs rather than inside it; throws on a value it cannot read.
 */
export function handedOverEndpointArg(argv: readonly string[]): {
  handedOverEndpoint?: DaemonSocketIdentity
} {
  const index = argv.indexOf('--handed-over-endpoint')
  return index === -1 ? {} : { handedOverEndpoint: parseHandedOverEndpoint(argv[index + 1] ?? '') }
}

/** Where the endpoint is published, and the live incumbent it is handed over from. */
export function daemonEndpointLocation(
  options: Pick<DaemonServerOptions, 'socketPath' | 'tokenPath' | 'handedOverEndpoint'>
): { socketPath: string; tokenPath: string; handedOverEndpoint: DaemonSocketIdentity | null } {
  return {
    socketPath: options.socketPath,
    tokenPath: options.tokenPath,
    handedOverEndpoint: options.handedOverEndpoint ?? null
  }
}
