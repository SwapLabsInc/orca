import type React from 'react'
import { useEffect, useRef, useState } from 'react'
import { Download, Loader2, RefreshCw } from 'lucide-react'
import { toast } from 'sonner'
import { useAppStore } from '../../store'
import { Button } from '../ui/button'
import { SearchableSetting } from './SearchableSetting'
import { SettingsSubsectionHeader } from './SettingsFormControls'
import { translate } from '@/i18n/i18n'
import { getUpdateCheckClickOptions, getUpdateCheckHint } from '@/lib/update-check-click-options'
import { readIpcErrorDetail } from '@/lib/ipc-error'
import { GeneralRemoteServerUpdates } from './GeneralRemoteServerUpdates'
import { ReleaseChannelSection } from './ReleaseChannelSection'
import {
  ReleaseSourceDownloadButtons,
  ReleaseSourceListErrors,
  ReleaseSourceUpdateHint,
  UpdateErrorHint
} from './ReleaseSourceUpdateControls'
import { useReleaseSourceStatuses } from './use-release-source-statuses'
import { getReleaseNotesUrlForVersion } from '../../../../shared/release-channel'
import {
  RELEASE_SOURCES,
  getReleaseSource,
  getVersionReleaseSource,
  isMultiSourceBuild
} from '../../../../shared/release-sources'
import type { UpdateStatus } from '../../../../shared/update-status-types'

function CheckForUpdatesButton({
  updateStatus,
  onCheck,
  holdWhileStaged = false
}: {
  updateStatus: UpdateStatus
  onCheck: (event: React.MouseEvent<HTMLButtonElement>) => void
  /** Multi-source rows: a staged cross-source build must be restarted into, not checked past. */
  holdWhileStaged?: boolean
}): React.JSX.Element {
  const staged = holdWhileStaged && updateStatus.state === 'downloaded'
  return (
    <Button
      variant="outline"
      size="sm"
      // Why: modifier-click channels are power-user update affordances, not
      // persistent settings toggles.
      onClick={onCheck}
      title={
        staged
          ? translate(
              'auto.components.settings.GeneralUpdateSettingsSection.stagedHold',
              'Restart to install the downloaded update first.'
            )
          : getUpdateCheckHint()
      }
      disabled={updateStatus.state === 'checking' || updateStatus.state === 'downloading' || staged}
    >
      {updateStatus.state === 'checking' ? (
        <Loader2 className="size-3.5 animate-spin" />
      ) : (
        <RefreshCw className="size-3.5" />
      )}
      {translate(
        'auto.components.settings.GeneralUpdateSettingsSection.e1a647adc5',
        'Check for Updates'
      )}
    </Button>
  )
}

function DownloadUpdateButton({ version }: { version: string }): React.JSX.Element {
  return (
    <Button
      variant="default"
      size="sm"
      onClick={() => {
        void window.api.updater.download().catch((error) => {
          toast.error(
            translate(
              'auto.components.settings.GeneralUpdateSettingsSection.02dc082e70',
              'Could not start the update download.'
            ),
            { description: readIpcErrorDetail(error) ?? String(error) }
          )
        })
      }}
    >
      <Download className="size-3.5" />
      {translate(
        'auto.components.settings.GeneralUpdateSettingsSection.42717918f4',
        'Download Update ('
      )}
      {version})
    </Button>
  )
}

function RestartToUpdateButton({
  version,
  onRestart
}: {
  version: string
  onRestart: () => void
}): React.JSX.Element {
  return (
    <Button variant="default" size="sm" onClick={onRestart}>
      <Download className="size-3.5" />
      {translate(
        'auto.components.settings.GeneralUpdateSettingsSection.f44299636f',
        'Restart to Update ('
      )}
      {version})
    </Button>
  )
}

export function GeneralUpdateSettingsSection(): React.JSX.Element {
  const updateStatus = useAppStore((s) => s.updateStatus)
  // Why: older hosts omit `version` from errors, so retain the last target for correct copy.
  const updateVersionRef = useRef<string | null>(null)
  if ('version' in updateStatus && updateStatus.version) {
    updateVersionRef.current = updateStatus.version
  } else if (
    updateStatus.state === 'checking' ||
    updateStatus.state === 'idle' ||
    updateStatus.state === 'not-available'
  ) {
    // Why: a new check cycle has started or completed cleanly. Clear the
    // cached version so a subsequent check failure cannot be mis-classified
    // as a download failure based on a stale version from a prior cycle.
    updateVersionRef.current = null
  }

  const [appVersion, setAppVersion] = useState<string | null>(null)
  // Why: channel switching is a power-user escape hatch that can downgrade the app
  // onto an unvetted build. Option/Alt-clicking the header reveals it rather than
  // shipping it on the default surface.
  const [channelSwitcherRevealed, setChannelSwitcherRevealed] = useState(false)
  // Why only multi-source builds list sources: an upstream build has one source and keeps
  // today's row; the read is never issued for it.
  const multiSource = isMultiSourceBuild()
  const releaseSources = useReleaseSourceStatuses(multiSource)
  const runningSource =
    multiSource && appVersion ? getReleaseSource(getVersionReleaseSource(appVersion) ?? '') : null
  const localBuildOffered = updateStatus.source === 'local'

  useEffect(() => {
    let cancelled = false
    void window.api.updater.getVersion().then((version) => {
      if (!cancelled) {
        setAppVersion(version)
      }
    })
    return () => {
      cancelled = true
    }
  }, [])

  const handleCheck = (event: React.MouseEvent<HTMLButtonElement>): void => {
    void window.api.updater.check(getUpdateCheckClickOptions(event))
    if (multiSource) {
      // Why force: the click means "what is out there now", not "what did the cache say five minutes ago".
      void releaseSources.reload({ force: true })
    }
  }

  const handleRestartToUpdate = (): void => {
    // Why: quitAndInstall resolves immediately (the actual quit happens in a
    // deferred timer in the main process), so rejection here is only possible
    // if the IPC channel itself breaks. Log defensively; the user will notice
    // the app didn't restart and can retry.
    void window.api.updater.quitAndInstall().catch(console.error)
  }

  return (
    <section key="updates" className="space-y-4">
      <div
        onClick={(event) => {
          if (event.altKey) {
            setChannelSwitcherRevealed((revealed) => !revealed)
          }
        }}
      >
        <SettingsSubsectionHeader
          title={translate(
            'auto.components.settings.GeneralUpdateSettingsSection.f2b1ccc12a',
            'Updates'
          )}
          description={
            runningSource
              ? translate(
                  'auto.components.settings.GeneralUpdateSettingsSection.currentVersionWithSource',
                  'Current version: {{value0}} · {{value1}}',
                  { value0: appVersion ?? '...', value1: runningSource.label }
                )
              : translate(
                  'auto.components.settings.GeneralUpdateSettingsSection.d91ebfb87e',
                  'Current version: {{value0}}',
                  { value0: appVersion ?? '...' }
                )
          }
        />
      </div>

      <SearchableSetting
        title={translate(
          'auto.components.settings.GeneralUpdateSettingsSection.e1a647adc5',
          'Check for Updates'
        )}
        description={translate(
          'auto.components.settings.GeneralUpdateSettingsSection.ceb579abaf',
          'Check for app updates and install a newer Orca version.'
        )}
        keywords={['update', 'version', 'release notes', 'download']}
        className="space-y-3"
      >
        {multiSource ? (
          <div className="flex flex-wrap items-center gap-3">
            <CheckForUpdatesButton
              updateStatus={updateStatus}
              onCheck={handleCheck}
              holdWhileStaged
            />
            {updateStatus.state === 'downloaded' ? (
              <RestartToUpdateButton
                version={updateStatus.version}
                onRestart={handleRestartToUpdate}
              />
            ) : localBuildOffered && updateStatus.state === 'available' ? (
              // Why: a local build (Option-click on macOS) is no source's release, so it keeps
              // the generic action instead of wearing a source button's label.
              <DownloadUpdateButton version={updateStatus.version} />
            ) : null}
            <ReleaseSourceDownloadButtons
              sources={releaseSources.sources}
              loading={releaseSources.loading}
              placeholders={RELEASE_SOURCES}
              runningSourceId={runningSource?.id ?? null}
              updateStatus={updateStatus}
              appVersion={appVersion}
            />
          </div>
        ) : (
          <div className="flex items-center gap-3">
            <CheckForUpdatesButton updateStatus={updateStatus} onCheck={handleCheck} />

            {updateStatus.state === 'available' && !updateStatus.externallyManaged ? (
              <DownloadUpdateButton version={updateStatus.version} />
            ) : updateStatus.state === 'downloaded' ? (
              <RestartToUpdateButton
                version={updateStatus.version}
                onRestart={handleRestartToUpdate}
              />
            ) : null}
          </div>
        )}

        <p className="text-xs text-muted-foreground">
          {multiSource && !localBuildOffered ? (
            <ReleaseSourceUpdateHint
              runningSourceId={runningSource?.id ?? null}
              updateStatus={updateStatus}
              checkFailed={updateVersionRef.current === null}
            />
          ) : (
            <SingleSourceUpdateHint
              updateStatus={updateStatus}
              checkFailed={updateVersionRef.current === null}
            />
          )}
        </p>
        {multiSource ? (
          <ReleaseSourceListErrors sources={releaseSources.sources} error={releaseSources.error} />
        ) : null}
      </SearchableSetting>
      {channelSwitcherRevealed ? <ReleaseChannelSection /> : null}
      <GeneralRemoteServerUpdates />
    </section>
  )
}

/** Today's single-source hint copy, unchanged apart from the download link on a refused jump. */
function SingleSourceUpdateHint({
  updateStatus,
  checkFailed
}: {
  updateStatus: UpdateStatus
  checkFailed: boolean
}): React.JSX.Element {
  return (
    <>
      {updateStatus.state === 'idle' &&
        translate(
          'auto.components.settings.GeneralUpdateSettingsSection.d69a09b672',
          'Updates are checked automatically on launch.'
        )}
      {updateStatus.state === 'checking' &&
        translate(
          'auto.components.settings.GeneralUpdateSettingsSection.31fd7150cf',
          'Checking for updates...'
        )}
      {updateStatus.state === 'available' && (
        <>
          {translate('auto.components.settings.GeneralUpdateSettingsSection.a6b37929dc', 'Version')}{' '}
          {updateStatus.version}{' '}
          {updateStatus.externallyManaged
            ? translate(
                'auto.components.settings.GeneralUpdateSettingsSection.e3b9d21c07',
                'is available. Update Orca through your system package manager — Orca cannot install this release itself.'
              )
            : translate(
                'auto.components.settings.GeneralUpdateSettingsSection.8311da27ba',
                'is available. Click "Download Update" to download it.'
              )}{' '}
          {updateStatus.source !== 'local' && (
            <a
              href={updateStatus.releaseUrl ?? getReleaseNotesUrlForVersion(updateStatus.version)}
              target="_blank"
              rel="noopener noreferrer"
              className="underline hover:text-foreground"
            >
              {translate(
                'auto.components.settings.GeneralUpdateSettingsSection.8a52ca1d02',
                'Release notes'
              )}
            </a>
          )}
        </>
      )}
      {updateStatus.state === 'not-available' &&
        translate(
          'auto.components.settings.GeneralUpdateSettingsSection.f40d88390d',
          'You’re on the latest version.'
        )}
      {updateStatus.state === 'downloading' &&
        translate(
          'auto.components.settings.GeneralUpdateSettingsSection.2a48034c4c',
          'Downloading v{{value0}}... {{value1}}%',
          { value0: updateStatus.version, value1: updateStatus.percent }
        )}
      {updateStatus.state === 'downloaded' && (
        <>
          {translate('auto.components.settings.GeneralUpdateSettingsSection.a6b37929dc', 'Version')}{' '}
          {updateStatus.version}{' '}
          {translate(
            'auto.components.settings.GeneralUpdateSettingsSection.d89806cc89',
            'is ready to install.'
          )}{' '}
          {updateStatus.source !== 'local' && (
            <a
              href={updateStatus.releaseUrl ?? getReleaseNotesUrlForVersion(updateStatus.version)}
              target="_blank"
              rel="noopener noreferrer"
              className="underline hover:text-foreground"
            >
              {translate(
                'auto.components.settings.GeneralUpdateSettingsSection.8a52ca1d02',
                'Release notes'
              )}
            </a>
          )}
        </>
      )}
      {updateStatus.state === 'error' && (
        <UpdateErrorHint
          message={updateStatus.message}
          checkFailed={checkFailed}
          plain={updateStatus.recovery?.kind === 'linux-package-install'}
          manualInstallUrl={updateStatus.manualInstallUrl ?? null}
        />
      )}
    </>
  )
}
