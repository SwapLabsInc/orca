import type React from 'react'
import { useTranslate } from '@/i18n/use-translate'
import type { UnsupportedSystemUpdate } from '../../../../../shared/update-status-types'

/** LOCAL: upstream's copy for a release this Mac's macOS cannot run, shared by both hint layouts. */
export function UnsupportedSystemUpdateHint({
  update
}: {
  update: UnsupportedSystemUpdate
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <>
      {t(
        'macosUpdateRequirement.settingsStatus',
        'Orca {{version}} requires macOS {{macos}} or later. This is the latest version for this Mac.',
        { version: update.version, macos: update.minimumMacosVersion }
      )}
    </>
  )
}
