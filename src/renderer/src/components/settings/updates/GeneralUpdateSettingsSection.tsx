import { getUpdateInstallBlockGuidance } from '../../maintenance/update-card/update-install-block-guidance'
import type React from 'react'
import { useEffect, useRef, useState } from 'react'
import { Download, Loader2, Power, RefreshCw } from 'lucide-react'
import { toast } from 'sonner'
import { useAppStore } from '../../../store/index'
import { Button } from '../../ui/button'
import { SearchableSetting } from '../section-layout/SearchableSetting'
import { SettingsGroup } from '../section-layout/SettingsGroup'
import { useTranslate } from '@/i18n/use-translate'
import {
  getUpdateCheckClickOptions,
  getUpdateCheckHint
} from '@/app-shell/updates/update-check-click-options'
import { readIpcErrorDetail } from '@/runtime/errors/ipc-error'
import { GeneralRemoteServerUpdates } from './GeneralRemoteServerUpdates'
import { ReleaseChannelSection } from './ReleaseChannelSection'
import {
  ReleaseSourceDownloadButtons,
  ReleaseSourceListErrors,
  ReleaseSourceUpdateHint
} from './ReleaseSourceUpdateControls'
import { useReleaseSourceStatuses } from './use-release-source-statuses'
import { UpdateDelaySetting } from './UpdateDelaySetting'
import { SingleSourceUpdateHint } from './SingleSourceUpdateHint'
import { AutomaticUpdatesSetting } from './AutomaticUpdatesSetting'
import { isWebClientLocation } from '@/app-shell/platform/web-client-location'
import {
  RELEASE_SOURCES,
  getReleaseSource,
  getVersionReleaseSource,
  isMultiSourceBuild
} from '../../../../../shared/updater/release-sources'
import type { UpdateStatus } from '../../../../../shared/updater/update-status-types'

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
      disabled={
        updateStatus.state === 'checking' ||
        updateStatus.state === 'downloading' ||
        (updateStatus.state === 'error' && updateStatus.messageCode === 'macStagingTimeout') ||
        (updateStatus.state === 'downloaded' && updateStatus.installing) ||
        staged
      }
    >
      {updateStatus.state === 'checking' ? (
        <Loader2 className="size-3.5 animate-spin" />
      ) : (
        <RefreshCw className="size-3.5" />
      )}
      {t('auto.components.settings.GeneralUpdateSettingsSection.6d27bd46e3', 'Check for updates')}
    </Button>
  )
}

function DownloadUpdateButton(): React.JSX.Element {
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
      {t('auto.components.settings.GeneralUpdateSettingsSection.downloadUpdate', 'Download update')}
    </Button>
  )
}

function RestartToUpdateButton({
  installing,
  onRestart
}: {
  installing?: boolean
  onRestart: () => void
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <Button variant="default" size="sm" onClick={onRestart} disabled={installing}>
      <Download className="size-3.5" />
      {t(
        'auto.components.settings.GeneralUpdateSettingsSection.restartToUpdate',
        'Restart to update'
      )}
    </Button>
  )
}

function RetryInstallButton({ onRetry }: { onRetry: () => void }): React.JSX.Element {
  const t = useTranslate()
  return (
    <Button variant="default" size="sm" onClick={onRetry}>
      <RefreshCw className="size-3.5" />
      {t('auto.components.UpdateCard.b3b02a9d84', 'Try again')}
    </Button>
  )
}

export function GeneralUpdateSettingsSection({
  children
}: { children?: React.ReactNode } = {}): React.JSX.Element {
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
  const installTarget = useAppStore((s) => s.retainedUpdateTarget)
  const [failedRestartTarget, setFailedRestartTarget] = useState<typeof installTarget>(null)
  const showManualRestart =
    updateStatus.installOnQuit === true &&
    (updateStatus.state === 'error' ||
      (updateStatus.state === 'downloaded' &&
        !updateStatus.installing &&
        installTarget !== null &&
        failedRestartTarget === installTarget))
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
    !showManualRestart &&
    updateStatus.state === 'error' &&
    updateStatus.retryAction === 'install' &&
    updateStatus.retryable !== false
  // An automatic install restarts by itself, so it offers no restart button.
  const automaticInstall =
    updateStatus.state === 'downloaded' &&
    updateStatus.automaticDownload === true &&
    updateStatus.installing === true

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
    void window.api.updater.quitAndInstall().catch((error: unknown) => {
      setFailedRestartTarget(installTarget)
      if (!updateStatus.installOnQuit) {
        toast.error(
          t(
            'auto.components.UpdateCard.restartToInstallFailed',
            'Could not restart to install the update.'
          ),
          { description: error instanceof Error ? error.message : String(error) }
        )
      }
    })
  }

  return (
    <SettingsGroup
      key="updates"
      title={t('settings.general.about.title', 'About')}
      onHeaderClick={(event) => {
        if (event.altKey) {
          setChannelSwitcherRevealed((revealed) => !revealed)
        }
      }}
    >
      <SearchableSetting
        title={t(
          'auto.components.settings.GeneralUpdateSettingsSection.6d27bd46e3',
          'Check for updates'
        )}
        description={t(
          'auto.components.settings.GeneralUpdateSettingsSection.ceb579abaf',
          'Check for app updates and install a newer Orca version.'
        )}
        keywords={['about', 'update', 'version', 'release notes', 'download']}
        className="space-y-3 py-3"
      >
        <div className="flex flex-wrap items-center justify-between gap-3">
          <span className="text-sm">
            {runningSource
              ? t(
                  'auto.components.settings.GeneralUpdateSettingsSection.currentVersionWithSource',
                  'Current version: {{value0}} · {{value1}}',
                  { value0: appVersion ?? '...', value1: runningSource.label }
                )
              : t('settings.general.about.version', 'Orca {{version}}', {
                  version: appVersion ?? '…'
                })}
          </span>
          {multiSource ? (
            <div className="flex flex-wrap items-center gap-3">
              <CheckForUpdatesButton
                updateStatus={updateStatus}
                onCheck={handleCheck}
                holdWhileStaged
              />
              {updateStatus.state === 'downloaded' && !automaticInstall && !showManualRestart ? (
                <RestartToUpdateButton
                  installing={updateStatus.installing}
                  onRestart={handleRestartToUpdate}
                />
              ) : installRetryOffered ? (
                <RetryInstallButton onRetry={handleRestartToUpdate} />
              ) : localBuildOffered && updateStatus.state === 'available' ? (
                // Why: a local build (Option-click on macOS) is no source's release, so it keeps
                // the generic action instead of wearing a source button's label.
                <DownloadUpdateButton />
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
            <>
              <CheckForUpdatesButton updateStatus={updateStatus} onCheck={handleCheck} />

              {updateStatus.state === 'available' && !updateStatus.externallyManaged ? (
                <DownloadUpdateButton />
              ) : installRetryOffered ? (
                <RetryInstallButton onRetry={handleRestartToUpdate} />
              ) : updateStatus.state === 'downloaded' && !automaticInstall && !showManualRestart ? (
                <RestartToUpdateButton
                  installing={updateStatus.installing}
                  onRestart={handleRestartToUpdate}
                />
              ) : null}
            </>
          )}
        </div>

        {showManualRestart && (
          // The action follows its copy and wraps below it, end-aligned, when narrow.
          <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
            <p className="text-xs text-muted-foreground">
              <span className="block font-medium text-foreground">
                {t('updates.installOnQuit.title', 'Update ready to install')}
              </span>
              {t('updates.installOnQuit.summary', 'Quit Orca. Reopen after installation.')}
            </p>
            <Button
              variant="default"
              size="sm"
              onClick={() => void window.api.app.quit().catch(console.error)}
              className="ms-auto"
            >
              <Power className="size-3.5" />
              {t('updates.installOnQuit.quit', 'Quit Orca')}
            </Button>
          </div>
        )}
        <p className="text-xs text-muted-foreground empty:hidden">
          {showManualRestart ? null : updateStatus.state === 'error' &&
            updateStatus.installBlock ? (
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
      {isWebClientLocation() ? null : <AutomaticUpdatesSetting />}
      <UpdateDelaySetting />
      {channelSwitcherRevealed ? <ReleaseChannelSection /> : null}
      <GeneralRemoteServerUpdates />
      {children}
    </SettingsGroup>
  )
}
