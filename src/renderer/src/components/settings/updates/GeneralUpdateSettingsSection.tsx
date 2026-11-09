import { getUpdateInstallBlockGuidance } from '../../maintenance/update-card/update-install-block-guidance'
import type React from 'react'
import { useEffect, useRef, useState } from 'react'
import { Download, Loader2, RefreshCw } from 'lucide-react'
import { toast } from 'sonner'
import { useAppStore } from '../../../store/index'
import { Button } from '../../ui/button'
import { SearchableSetting } from '../section-layout/SearchableSetting'
import { SettingsGroup } from '../section-layout/SettingsGroup'
import { useTranslate } from '@/i18n/use-translate'
import { updaterMessageText } from '@/lib/updater-message-copy'
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
import { UpdateDelaySetting } from './UpdateDelaySetting'
import { DelayedUpdateHint } from './DelayedUpdateHint'
import { UnsupportedSystemUpdateHint } from './UnsupportedSystemUpdateHint'
import { getReleaseNotesUrlForVersion } from '../../../../../shared/release-channel'
import { openAppHttpLinkFromAnchor } from '@/lib/browser/navigation/app-http-link-open'
import {
  RELEASE_SOURCES,
  getReleaseSource,
  getVersionReleaseSource,
  isMultiSourceBuild
} from '../../../../../shared/release-sources'
import type { UpdateStatus } from '../../../../../shared/update-status-types'

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
  const t = useTranslate()
  const staged = holdWhileStaged && updateStatus.state === 'downloaded'
  return (
    <Button
      variant="outline"
      size="sm"
      // Modifier clicks are one-off update actions, not saved toggles.
      onClick={onCheck}
      title={
        staged
          ? t(
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
      {t('auto.components.settings.GeneralUpdateSettingsSection.e1a647adc5', 'Check for Updates')}
    </Button>
  )
}

function DownloadUpdateButton({ version }: { version: string }): React.JSX.Element {
  const t = useTranslate()
  return (
    <Button
      variant="default"
      size="sm"
      onClick={() => {
        void window.api.updater.download().catch((error) => {
          toast.error(
            t(
              'auto.components.settings.GeneralUpdateSettingsSection.02dc082e70',
              'Could not start the update download.'
            ),
            { description: readIpcErrorDetail(error) ?? String(error) }
          )
        })
      }}
    >
      <Download className="size-3.5" />
      {t('auto.components.settings.GeneralUpdateSettingsSection.42717918f4', 'Download Update (')}
      {version})
    </Button>
  )
}

function RestartToUpdateButton({
  version,
  installing,
  onRestart
}: {
  version: string
  installing?: boolean
  onRestart: () => void
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <Button variant="default" size="sm" onClick={onRestart} disabled={installing}>
      <Download className="size-3.5" />
      {t('auto.components.settings.GeneralUpdateSettingsSection.f44299636f', 'Restart to Update (')}
      {version})
    </Button>
  )
}

function RetryInstallButton({ onRetry }: { onRetry: () => void }): React.JSX.Element {
  const t = useTranslate()
  return (
    <Button variant="default" size="sm" onClick={onRetry}>
      <RefreshCw className="size-3.5" />
      {t('auto.components.UpdateCard.2c2d3e03ca', 'Try Again')}
    </Button>
  )
}

export function GeneralUpdateSettingsSection(): React.JSX.Element {
  const t = useTranslate()
  const updateStatus = useAppStore((s) => s.updateStatus)
  // Older hosts omit error versions; retain the target for accurate failure copy.
  const updateVersionRef = useRef<string | null>(null)
  if ('version' in updateStatus && updateStatus.version) {
    updateVersionRef.current = updateStatus.version
  } else if (
    updateStatus.state === 'checking' ||
    updateStatus.state === 'idle' ||
    updateStatus.state === 'not-available'
  ) {
    // Clear old targets on clean/new cycles so later check failures cannot look like stale download failures.
    updateVersionRef.current = null
  }

  const [appVersion, setAppVersion] = useState<string | null>(null)
  // Hide channel switching behind Option/Alt-click because it can downgrade to unvetted builds.
  const [channelSwitcherRevealed, setChannelSwitcherRevealed] = useState(false)
  // Why only multi-source builds list sources: an upstream build has one source and keeps
  // today's row; the read is never issued for it.
  const multiSource = isMultiSourceBuild()
  const releaseSources = useReleaseSourceStatuses(multiSource)
  const runningSource =
    multiSource && appVersion ? getReleaseSource(getVersionReleaseSource(appVersion) ?? '') : null
  const localBuildOffered = updateStatus.source === 'local'
  const installRetryOffered =
    updateStatus.state === 'error' &&
    updateStatus.retryAction === 'install' &&
    updateStatus.retryable !== false

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
    // quitAndInstall schedules quitting and resolves early; only broken IPC can reject here.
    void window.api.updater.quitAndInstall().catch(console.error)
  }

  return (
    <SettingsGroup
      key="updates"
      title={t('auto.components.settings.GeneralUpdateSettingsSection.f2b1ccc12a', 'Updates')}
      onHeaderClick={(event) => {
        if (event.altKey) {
          setChannelSwitcherRevealed((revealed) => !revealed)
        }
      }}
      description={
        runningSource
          ? t(
              'auto.components.settings.GeneralUpdateSettingsSection.currentVersionWithSource',
              'Current version: {{value0}} · {{value1}}',
              { value0: appVersion ?? '...', value1: runningSource.label }
            )
          : t(
              'auto.components.settings.GeneralUpdateSettingsSection.d91ebfb87e',
              'Current version: {{value0}}',
              { value0: appVersion ?? '...' }
            )
      }
    >
      <SearchableSetting
        title={t(
          'auto.components.settings.GeneralUpdateSettingsSection.e1a647adc5',
          'Check for Updates'
        )}
        description={t(
          'auto.components.settings.GeneralUpdateSettingsSection.ceb579abaf',
          'Check for app updates and install a newer Orca version.'
        )}
        keywords={['update', 'version', 'release notes', 'download']}
        className="space-y-3 py-3"
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
                installing={updateStatus.installing}
                onRestart={handleRestartToUpdate}
              />
            ) : installRetryOffered ? (
              <RetryInstallButton onRetry={handleRestartToUpdate} />
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
            ) : installRetryOffered ? (
              <RetryInstallButton onRetry={handleRestartToUpdate} />
            ) : updateStatus.state === 'downloaded' ? (
              <RestartToUpdateButton
                version={updateStatus.version}
                installing={updateStatus.installing}
                onRestart={handleRestartToUpdate}
              />
            ) : null}
          </div>
        )}

        <p className="text-xs text-muted-foreground">
          {updateStatus.state === 'error' && updateStatus.installBlock ? (
            getUpdateInstallBlockGuidance(updateStatus.installBlock, t).explainer
          ) : multiSource && !localBuildOffered ? (
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
      <UpdateDelaySetting />
      {channelSwitcherRevealed ? <ReleaseChannelSection /> : null}
      <GeneralRemoteServerUpdates />
    </SettingsGroup>
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
          {t('auto.components.settings.GeneralUpdateSettingsSection.a6b37929dc', 'Version')}{' '}
          {updateStatus.version}{' '}
          {updateStatus.externallyManaged
            ? t(
                'auto.components.settings.GeneralUpdateSettingsSection.e3b9d21c07',
                'is available. Update Orca through your system package manager — Orca cannot install this release itself.'
              )
            : t(
                'auto.components.settings.GeneralUpdateSettingsSection.8311da27ba',
                'is available. Click "Download Update" to download it.'
              )}{' '}
          {updateStatus.source !== 'local' && (
            <a
              href={updateStatus.releaseUrl ?? getReleaseNotesUrlForVersion(updateStatus.version)}
              target="_blank"
              onClick={openAppHttpLinkFromAnchor}
              rel="noopener noreferrer"
              className="underline hover:text-foreground"
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
          'auto.components.settings.GeneralUpdateSettingsSection.2a48034c4c',
          'Downloading v{{value0}}... {{value1}}%',
          { value0: updateStatus.version, value1: updateStatus.percent }
        )}
      {updateStatus.state === 'downloaded' && (
        <>
          {t('auto.components.settings.GeneralUpdateSettingsSection.a6b37929dc', 'Version')}{' '}
          {updateStatus.version}{' '}
          {t(
            'auto.components.settings.GeneralUpdateSettingsSection.d89806cc89',
            'is ready to install.'
          )}{' '}
          {updateStatus.source !== 'local' && (
            <a
              href={updateStatus.releaseUrl ?? getReleaseNotesUrlForVersion(updateStatus.version)}
              target="_blank"
              onClick={openAppHttpLinkFromAnchor}
              rel="noopener noreferrer"
              className="underline hover:text-foreground"
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
