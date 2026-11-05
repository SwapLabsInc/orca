import { abandonDaemonDrain, type DaemonDrainHandOver } from './daemon-drain'

export function abandonUnfinishedDrain(
  handOver: DaemonDrainHandOver | null,
  socketPath: string,
  pidPath: string
): void {
  if (handOver && abandonDaemonDrain(handOver, socketPath, pidPath)) {
    console.warn('[daemon] Drain abandoned: the fresh daemon did not take the endpoint')
  }
}
