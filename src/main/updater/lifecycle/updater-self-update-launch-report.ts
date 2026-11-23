import type { BrowserWindow } from 'electron'
import { getMacSelfUpdateLaunchFailure } from '../mac-self-update/mac-self-update-launch-outcome'
import { UpdaterSetup, type UpdaterSetupOptions } from './updater-setup'

/** LOCAL: the fork's side of `setupAutoUpdater`, whose upstream file sits at its line limit. */
export class UpdaterSetupWithSelfUpdateLaunchReport extends UpdaterSetup {
  override setupAutoUpdater(mainWindow: BrowserWindow | null, opts?: UpdaterSetupOptions): void {
    // A self-update that the helper rolled back is only visible from the build that came back.
    const failure = getMacSelfUpdateLaunchFailure()
    if (failure) {
      // Why before setup: an error status ends a running check, and setup starts the first one.
      this.getMainWindow =
        opts?.getMainWindow ?? (mainWindow ? () => mainWindow : this.getMainWindow)
      this.sendErrorStatus(failure, true)
    }
    super.setupAutoUpdater(mainWindow, opts)
  }
}
