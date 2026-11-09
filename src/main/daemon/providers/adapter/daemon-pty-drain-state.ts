import { DaemonPtyPreservedHostLoss } from './daemon-pty-preserved-host-loss'
import type { DaemonPtyAdapterOptions } from './daemon-pty-adapter-options'

/** SwapLabs #25: whether this adapter fronts a daemon drained for a newer bundle (daemon-drain.ts). */
export abstract class DaemonPtyDrainState extends DaemonPtyPreservedHostLoss {
  readonly draining: boolean

  constructor(opts: DaemonPtyAdapterOptions) {
    super(opts)
    this.draining = opts.draining === true
  }
}
