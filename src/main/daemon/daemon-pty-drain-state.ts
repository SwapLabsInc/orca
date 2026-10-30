import { DaemonPtyDaemonRecovery } from './daemon-pty-daemon-recovery'
import type { DaemonPtyAdapterOptions } from './daemon-pty-runtime-state'

/** SwapLabs #25: whether this adapter fronts a daemon drained for a newer bundle (daemon-drain.ts). */
export abstract class DaemonPtyDrainState extends DaemonPtyDaemonRecovery {
  readonly draining: boolean

  constructor(opts: DaemonPtyAdapterOptions) {
    super(opts)
    this.draining = opts.draining === true
  }
}
