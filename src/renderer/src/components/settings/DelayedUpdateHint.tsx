import type React from 'react'
import { useNow } from '@/hooks/use-now'
import { translate } from '@/i18n/i18n'
import { isDelayedUpdatePending } from '../../../../shared/update-delay'
import type { DelayedUpdate } from '../../../../shared/update-status-types'
import { formatUpdateDelayDate } from './update-delay-copy'

/** LOCAL: upstream's copy for a release the update delay holds, shared by both hint layouts. */
export function DelayedUpdateHint({
  delayedUpdate
}: {
  delayedUpdate: DelayedUpdate
}): React.JSX.Element {
  const now = useNow(60_000, true)
  return (
    <>
      {isDelayedUpdatePending(delayedUpdate, now)
        ? translate(
            'settings.updateDelay.upToDateWithHeld',
            'You’re up to date. A newer release is on hold until {{date}}.',
            { date: formatUpdateDelayDate(Date.parse(delayedUpdate.availableAt)) }
          )
        : translate(
            'settings.updateDelay.heldReleaseReady',
            'A newer release is ready. Check for updates to get it.'
          )}
    </>
  )
}
