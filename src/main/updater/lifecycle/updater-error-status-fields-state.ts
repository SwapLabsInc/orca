import type { UpdateStatus } from '../../../shared/updater/update-status-types'
import type { UpdaterCodedMessage } from '../../../shared/updater/updater-failure-copy'
import { readUpdateErrorPresentation } from '../mac-self-update/mac-self-update-failure'
import {
  errorStatusFields,
  repeatsErrorStatusFields,
  type ErrorStatusFields
} from '../updater-error-status-fields'
import { UpdaterCheckState } from './updater-check-state'

type ErrorUpdateStatus = Extract<UpdateStatus, { state: 'error' }>

/** LOCAL: the fork's side of `UpdaterCheckState`, whose upstream file sits at its line limit. */
export abstract class UpdaterErrorStatusFieldsState extends UpdaterCheckState {
  /** What the error being sent adds to its status; the base compares and sends them with its own. */
  private errorFields: ErrorStatusFields = {}
  /** The settled check's own error, whose source and card presentation its re-send keeps. */
  private settledError: ErrorUpdateStatus | null = null

  protected override finishActiveUpdateCheckAttempt(): void {
    super.finishActiveUpdateCheckAttempt()
    // Why: the launch-pending flag belongs to the attempt. A result status sent mid-preflight (a
    // pinned jump refused, a same-version pin, a dismiss) ends the attempt; a flag that outlived it
    // deferred every later check as "already in flight", with no stall timer left to clear it.
    this.backgroundCheckLaunchPending = false
  }

  protected override sendErrorStatus(
    failure: string | UpdaterCodedMessage,
    userInitiated?: boolean,
    /** The source it refers to, and a manual-install page or retry verdict for the card. */
    ...[
      releaseSource = this.settledError?.releaseSource,
      presentation = this.settledError ?? {}
    ]: Partial<Parameters<typeof errorStatusFields>>
  ): void {
    const coded = typeof failure === 'string' ? { message: failure } : failure
    this.errorFields = errorStatusFields(releaseSource, presentation)
    // Why inside the message: the base spreads it into the status it sends.
    super.sendErrorStatus({ ...coded, ...this.errorFields }, userInitiated)
  }

  protected repeatsErrorFields(current: ErrorUpdateStatus): boolean {
    return repeatsErrorStatusFields(current, this.errorFields)
  }

  protected override sendSettledCheckStatus(status: UpdateStatus): void {
    // Why the status itself: its manual-install page and retry verdict must reach the card intact.
    this.settledError = status.state === 'error' ? status : null
    try {
      super.sendSettledCheckStatus(status)
    } finally {
      this.settledError = null
    }
  }

  /** An updater event's failure, with the card presentation its error carries. */
  protected sendUpdaterEventErrorStatus(
    message: string,
    userInitiated?: boolean,
    error?: unknown
  ): void {
    this.sendErrorStatus(message, userInitiated, undefined, readUpdateErrorPresentation(error))
  }
}
