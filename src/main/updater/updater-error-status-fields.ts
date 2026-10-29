import type { ReleaseSourceId } from '../../shared/release-sources'
import type { UpdateStatus } from '../../shared/update-status-types'
import {
  pickUpdateErrorPresentation,
  type UpdateErrorPresentation
} from './mac-self-update/mac-self-update-failure'

/** What a fork error status adds: the release source it refers to, and the card's manual-install page and retry verdict. */
export type ErrorStatusFields = UpdateErrorPresentation & { releaseSource?: ReleaseSourceId }

export function errorStatusFields(
  releaseSource: ReleaseSourceId | undefined,
  presentation: UpdateErrorPresentation
): ErrorStatusFields {
  return {
    ...pickUpdateErrorPresentation(presentation),
    ...(releaseSource ? { releaseSource } : {})
  }
}

/** Why each field: an error that differs only in its source or card presentation is a new error, not a repeat. */
export function repeatsErrorStatusFields(
  current: Extract<UpdateStatus, { state: 'error' }>,
  fields: ErrorStatusFields
): boolean {
  return (
    current.releaseSource === fields.releaseSource &&
    current.manualInstallUrl === fields.manualInstallUrl &&
    current.retryable === fields.retryable
  )
}

/** The source a failed pinned jump targeted, when it is not the running one — read before the feed is handed back. */
export function pinnedReleaseSourceForStatus(
  activeReleaseSource: ReleaseSourceId | null,
  runningReleaseSource: ReleaseSourceId | null
): ReleaseSourceId | undefined {
  return activeReleaseSource !== null && activeReleaseSource !== runningReleaseSource
    ? activeReleaseSource
    : undefined
}
