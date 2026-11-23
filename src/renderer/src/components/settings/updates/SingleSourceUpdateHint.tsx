import type React from 'react'
import { useTranslate } from '@/i18n/use-translate'
import { updaterMessageText } from '@/app-shell/updates/updater-message-copy'
import { openAppHttpLinkFromAnchor } from '@/lib/browser/navigation/app-http-link-open'
import { getReleaseNotesUrlForVersion } from '../../../../../shared/updater/release-channel'
import type { UpdateStatus } from '../../../../../shared/updater/update-status-types'
import { DelayedUpdateHint } from './DelayedUpdateHint'
import { UpdateErrorHint } from './ReleaseSourceUpdateControls'
import { UnsupportedSystemUpdateHint } from './UnsupportedSystemUpdateHint'

/** Today's single-source hint copy, unchanged apart from the download link on a refused jump. */
export function SingleSourceUpdateHint({
  updateStatus,
  checkFailed
}: {
  updateStatus: UpdateStatus
  checkFailed: boolean
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <>
      {updateStatus.state === 'idle' &&
        t(
          'auto.components.settings.GeneralUpdateSettingsSection.d69a09b672',
          'Updates are checked automatically on launch.'
        )}
      {updateStatus.state === 'checking' &&
        t(
          'auto.components.settings.GeneralUpdateSettingsSection.31fd7150cf',
          'Checking for updates...'
        )}
      {updateStatus.state === 'available' && (
        <>
          {updateStatus.externallyManaged
            ? t(
                'auto.components.settings.GeneralUpdateSettingsSection.externallyManagedVersionAvailable',
                'Version {{version}} is available. Update Orca through your system package manager — Orca cannot install this release itself.',
                { version: updateStatus.version }
              )
            : t(
                'auto.components.settings.GeneralUpdateSettingsSection.versionAvailable',
                'Version {{version}} is available.',
                { version: updateStatus.version }
              )}
          {updateStatus.source !== 'local' && (
            <a
              href={updateStatus.releaseUrl ?? getReleaseNotesUrlForVersion(updateStatus.version)}
              target="_blank"
              onClick={openAppHttpLinkFromAnchor}
              rel="noopener noreferrer"
              className="ms-1 whitespace-nowrap underline hover:text-foreground"
            >
              {t(
                'auto.components.settings.GeneralUpdateSettingsSection.8a52ca1d02',
                'Release notes'
              )}
            </a>
          )}
        </>
      )}
      {updateStatus.state === 'not-available' &&
        (updateStatus.unsupportedSystemUpdate ? (
          <UnsupportedSystemUpdateHint update={updateStatus.unsupportedSystemUpdate} />
        ) : updateStatus.delayedUpdate ? (
          <DelayedUpdateHint delayedUpdate={updateStatus.delayedUpdate} />
        ) : (
          t(
            'auto.components.settings.GeneralUpdateSettingsSection.f40d88390d',
            'You’re on the latest version.'
          )
        ))}
      {updateStatus.state === 'downloading' &&
        t(
          'auto.components.settings.GeneralUpdateSettingsSection.downloadingVersion',
          'Downloading version {{version}} ({{percent}}%)…',
          { version: updateStatus.version, percent: updateStatus.percent }
        )}
      {updateStatus.state === 'downloaded' && (
        <>
          {updateStatus.installing
            ? t(
                'auto.components.settings.GeneralUpdateSettingsSection.versionInstalling',
                'Version {{version}} is being installed.',
                { version: updateStatus.version }
              )
            : t(
                'auto.components.settings.GeneralUpdateSettingsSection.versionReadyToInstall',
                'Version {{version}} is ready to install.',
                { version: updateStatus.version }
              )}
          {updateStatus.source !== 'local' && (
            <a
              href={updateStatus.releaseUrl ?? getReleaseNotesUrlForVersion(updateStatus.version)}
              target="_blank"
              onClick={openAppHttpLinkFromAnchor}
              rel="noopener noreferrer"
              className="ms-1 whitespace-nowrap underline hover:text-foreground"
            >
              {t(
                'auto.components.settings.GeneralUpdateSettingsSection.8a52ca1d02',
                'Release notes'
              )}
            </a>
          )}
        </>
      )}
      {updateStatus.state === 'error' && (
        <UpdateErrorHint
          message={updaterMessageText(updateStatus)}
          checkFailed={checkFailed}
          plain={updateStatus.recovery?.kind === 'linux-package-install'}
          manualInstallUrl={updateStatus.manualInstallUrl ?? null}
        />
      )}
    </>
  )
}
