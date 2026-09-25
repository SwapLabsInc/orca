import type React from 'react'
import { Download, ExternalLink, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { Badge } from '../ui/badge'
import { Button } from '../ui/button'
import { translate } from '@/i18n/i18n'
import { readIpcErrorDetail } from '@/lib/ipc-error'
import {
  compareReleaseVersions,
  getReleaseNotesUrlForVersion
} from '../../../../shared/release-channel'
import { getReleaseSourceOrPrimary } from '../../../../shared/release-sources'
import type { ReleaseSourceStatus, UpdateStatus } from '../../../../shared/update-status-types'

type ReleaseSourceControlsProps = {
  /** Null until the first list resolves. */
  sources: ReleaseSourceStatus[] | null
  /** Derived from the running version in the renderer, so it is known before the list arrives. */
  runningSourceId: string | null
  updateStatus: UpdateStatus
  appVersion: string | null
}

/** The source a status speaks for: absent on the wire always means the running build's own. */
function getStatusSourceLabel(updateStatus: UpdateStatus, runningSourceId: string | null): string {
  return getReleaseSourceOrPrimary(updateStatus.releaseSource ?? runningSourceId).label
}

function ReleaseNotesLink({ version }: { version: string }): React.JSX.Element {
  return (
    <a
      href={getReleaseNotesUrlForVersion(version)}
      target="_blank"
      rel="noopener noreferrer"
      className="underline hover:text-foreground"
    >
      {translate(
        'auto.components.settings.GeneralUpdateSettingsSection.8a52ca1d02',
        'Release notes'
      )}
    </a>
  )
}

function ReleaseSourceButton({
  source,
  updateStatus,
  appVersion,
  loading
}: {
  source: ReleaseSourceStatus
  updateStatus: UpdateStatus
  appVersion: string | null
  loading: boolean
}): React.JSX.Element {
  const updaterBusy = updateStatus.state === 'checking' || updateStatus.state === 'downloading'
  // Why a staged download only holds the in-app rows: opening a release page conflicts with
  // nothing, and it is the way out for someone whose in-app jump was refused.
  const manual = source.install !== 'in-app'
  const busy = updaterBusy || (updateStatus.state === 'downloaded' && !manual)
  // Why the fallback to the running source: an absent releaseSource always means the running
  // build's own source, so only that source's button follows an unlabelled status. A local build
  // (Option-click on macOS) is no source's release, so no button speaks for it.
  const speaksForThisSource =
    updateStatus.source !== 'local' &&
    (updateStatus.releaseSource ?? (source.running ? source.id : null)) === source.id
  // Why the routine result wins over the list: a sticky check may have found a build the
  // five-minute list cache has not seen yet, and its download is already staged in main.
  const offeredByStatus =
    updateStatus.state === 'available' && !updateStatus.externallyManaged && speaksForThisSource
  const target = source.latest
  const version = offeredByStatus ? updateStatus.version : (target?.version ?? null)
  const isRunningBuild = version !== null && version === appVersion
  // Why "at or newer", not equality: the list may lag the running build (a release not yet
  // listed, or withdrawn), and the pinned check allows downgrades — so equality alone would
  // leave a prominent button that installs the older listed build. Only the running source
  // orders against the running version; across sources the versions do not compare.
  const runningIsCurrent =
    source.running &&
    !offeredByStatus &&
    (appVersion === null ||
      (target !== null && compareReleaseVersions(target.version, appVersion) <= 0))
  const disabled = busy || loading || (!offeredByStatus && (target === null || runningIsCurrent))
  const spinning =
    loading ||
    ((updateStatus.state === 'checking' || updateStatus.state === 'downloading') &&
      speaksForThisSource)

  const handleClick = (): void => {
    if (offeredByStatus) {
      void window.api.updater.download().catch((error) => {
        toast.error(
          translate(
            'auto.components.settings.GeneralUpdateSettingsSection.02dc082e70',
            'Could not start the update download.'
          ),
          { description: readIpcErrorDetail(error) ?? String(error) }
        )
      })
      return
    }
    if (!target) {
      return
    }
    if (manual) {
      // Why the release page for a managed package: the AppImage asset is not what a deb/rpm
      // install wants, and the page lists every package the release carries.
      void window.api.shell.openUrl(
        source.install === 'externally-managed'
          ? target.releaseUrl
          : (target.installerUrl ?? target.releaseUrl)
      )
      return
    }
    void window.api.updater
      .check({
        channel: target.channel,
        targetTag: target.tag,
        source: source.id,
        targetVersion: target.version,
        autoDownload: true
      })
      .catch((error) => {
        toast.error(
          translate(
            'auto.components.settings.GeneralUpdateSettingsSection.sourceUpdateFailed',
            'Could not start the {{value0}} update.',
            { value0: source.label }
          ),
          { description: readIpcErrorDetail(error) ?? String(error) }
        )
      })
  }

  return (
    <span className="inline-flex items-center gap-2">
      <Button
        variant={source.running && !disabled ? 'default' : 'secondary'}
        size="sm"
        type="button"
        disabled={disabled}
        onClick={handleClick}
        // Why the version only for a manual page: the in-app label already carries it.
        title={
          isRunningBuild && !offeredByStatus
            ? translate(
                'auto.components.settings.ReleaseChannelSection.alreadyRunning',
                'This is the build you are running.'
              )
            : runningIsCurrent && target !== null
              ? translate(
                  'auto.components.settings.GeneralUpdateSettingsSection.newerThanListed',
                  'You are running a newer build than the newest listed {{value0}} build ({{value1}}).',
                  { value0: source.label, value1: target.version }
                )
              : manual
                ? (version ?? undefined)
                : undefined
        }
      >
        {spinning ? (
          <Loader2 className="size-3.5 animate-spin" />
        ) : manual ? (
          <ExternalLink className="size-3.5" />
        ) : (
          <Download className="size-3.5" />
        )}
        {manual
          ? translate(
              'auto.components.settings.GeneralUpdateSettingsSection.openDownloadPage',
              'Open download page ({{value0}})',
              { value0: source.label }
            )
          : version
            ? translate(
                'auto.components.settings.GeneralUpdateSettingsSection.downloadFromSource',
                'Download {{value0}} ({{value1}})',
                { value0: version, value1: source.label }
              )
            : translate(
                'auto.components.settings.GeneralUpdateSettingsSection.downloadFromSourcePending',
                'Download ({{value0}})',
                { value0: source.label }
              )}
      </Button>
      {source.running ? (
        <Badge variant="outline">
          {translate(
            'auto.components.settings.GeneralUpdateSettingsSection.currentSource',
            'Current source'
          )}
        </Badge>
      ) : null}
    </span>
  )
}

/** One button per configured release source; the placeholder rows keep the layout while the list loads. */
export function ReleaseSourceDownloadButtons({
  sources,
  runningSourceId,
  updateStatus,
  appVersion,
  placeholders,
  loading
}: ReleaseSourceControlsProps & {
  /** Rendered disabled until `sources` resolves, so the row never appears empty. */
  placeholders: readonly { id: string; label: string }[]
  loading: boolean
}): React.JSX.Element {
  const rows: ReleaseSourceStatus[] =
    sources ??
    placeholders.map((source) => ({
      id: source.id,
      label: source.label,
      running: source.id === runningSourceId,
      install: 'in-app',
      latest: null,
      error: null
    }))
  return (
    <>
      {rows.map((source) => (
        <ReleaseSourceButton
          key={source.id}
          source={source}
          updateStatus={updateStatus}
          appVersion={appVersion}
          loading={loading && sources === null}
        />
      ))}
    </>
  )
}

/** Per-source list failures, shown beside the row so the sources that answered stay usable. */
export function ReleaseSourceListErrors({
  sources,
  error
}: {
  sources: ReleaseSourceStatus[] | null
  error: string | null
}): React.JSX.Element | null {
  const failures = [
    ...(error ? [error] : []),
    ...(sources ?? []).flatMap((source) =>
      source.error ? [`${source.label}: ${source.error}`] : []
    )
  ]
  if (failures.length === 0) {
    return null
  }
  return (
    <>
      {failures.map((failure) => (
        <p key={failure} className="text-xs text-destructive">
          {failure}
        </p>
      ))}
    </>
  )
}

/** The hint line for multi-source builds: every state names the source it speaks for. */
export function ReleaseSourceUpdateHint({
  runningSourceId,
  updateStatus,
  checkFailed
}: Pick<ReleaseSourceControlsProps, 'runningSourceId' | 'updateStatus'> & {
  /** True when an error status has no known download target, so it reads as a failed check. */
  checkFailed: boolean
}): React.JSX.Element | null {
  const label = getStatusSourceLabel(updateStatus, runningSourceId)
  switch (updateStatus.state) {
    case 'idle':
      return (
        <>
          {translate(
            'auto.components.settings.GeneralUpdateSettingsSection.idleWithSource',
            'Updates are checked automatically on launch against the {{value0}} releases.',
            { value0: label }
          )}
        </>
      )
    case 'checking':
      return (
        <>
          {translate(
            'auto.components.settings.GeneralUpdateSettingsSection.checkingSource',
            'Checking {{value0}} releases...',
            { value0: label }
          )}
        </>
      )
    case 'not-available':
      return (
        <>
          {translate(
            'auto.components.settings.GeneralUpdateSettingsSection.latestFromSource',
            'You’re on the latest {{value0}} build.',
            { value0: label }
          )}
        </>
      )
    case 'available':
      return (
        <>
          {translate('auto.components.settings.GeneralUpdateSettingsSection.a6b37929dc', 'Version')}{' '}
          {updateStatus.version} ({label}){' '}
          {updateStatus.externallyManaged
            ? translate(
                'auto.components.settings.GeneralUpdateSettingsSection.e3b9d21c07',
                'is available. Update Orca through your system package manager — Orca cannot install this release itself.'
              )
            : translate(
                'auto.components.settings.GeneralUpdateSettingsSection.isAvailable',
                'is available.'
              )}{' '}
          {updateStatus.source !== 'local' && <ReleaseNotesLink version={updateStatus.version} />}
        </>
      )
    case 'downloading':
      return (
        <>
          {translate(
            'auto.components.settings.GeneralUpdateSettingsSection.downloadingFromSource',
            'Downloading v{{value0}} ({{value1}})... {{value2}}%',
            { value0: updateStatus.version, value1: label, value2: updateStatus.percent }
          )}
        </>
      )
    case 'downloaded':
      return (
        <>
          {translate('auto.components.settings.GeneralUpdateSettingsSection.a6b37929dc', 'Version')}{' '}
          {updateStatus.version} ({label}){' '}
          {translate(
            'auto.components.settings.GeneralUpdateSettingsSection.d89806cc89',
            'is ready to install.'
          )}{' '}
          {updateStatus.source !== 'local' && <ReleaseNotesLink version={updateStatus.version} />}
        </>
      )
    case 'error':
      return (
        <UpdateErrorHint
          message={updateStatus.message}
          checkFailed={checkFailed && updateStatus.recovery?.kind !== 'linux-package-install'}
          plain={updateStatus.recovery?.kind === 'linux-package-install'}
          manualInstallUrl={updateStatus.manualInstallUrl ?? null}
        />
      )
  }
}

/** Error copy shared by both layouts; the link is the refused build's release page. */
export function UpdateErrorHint({
  message,
  checkFailed,
  plain,
  manualInstallUrl
}: {
  message: string
  checkFailed: boolean
  /** Package-recovery messages already read as instructions; no "Update error." prefix. */
  plain: boolean
  manualInstallUrl: string | null
}): React.JSX.Element {
  return (
    <>
      {plain
        ? message
        : checkFailed
          ? translate(
              'auto.components.settings.GeneralUpdateSettingsSection.bd79d412f0',
              'Update check failed. {{value0}}',
              { value0: message }
            )
          : translate(
              'auto.components.settings.GeneralUpdateSettingsSection.b9ad70c30d',
              'Update error. {{value0}}',
              { value0: message }
            )}
      {manualInstallUrl ? (
        <>
          {' '}
          <a
            href={manualInstallUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="underline hover:text-foreground"
          >
            {translate(
              'auto.components.settings.GeneralUpdateSettingsSection.openReleasePage',
              'Open download page'
            )}
          </a>
        </>
      ) : null}
    </>
  )
}
