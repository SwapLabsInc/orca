import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Loader2 } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import {
  getRepoExecutionHostId,
  isRuntimeOwnedSshTargetId,
  normalizeExecutionHostId,
  parseExecutionHostId
} from '../../../../shared/execution-host'
import { selectExecutionHostDisplayLabel } from '@/lib/execution-host-display-label'
import { isPairedWebClientWindow } from '@/lib/desktop-window-chrome'
import { countOpenRepoTerminalTabs } from '@/store/repos/repo-removal'
import { getRecipeVmSshTargetForHost } from '@/lib/recipe-vm-managed-host'
import { RemovalUnsavedFilesNotice } from './RemovalUnsavedFilesNotice'
import { confirmUnsavedDiscard } from '@/store/slices/worktrees/teardown/removed-workspace-unsaved-files'
import { projectRemovalTargets } from './removal-unsaved-files'
import {
  selectDetectedWorktreesByRepo,
  selectWorktreesByRepo
} from '@/store/workspace-record-selectors'

// Why: interpolated into the sentence so locales control where the name sits;
// U+0000 cannot appear in a real project name, so the split is unambiguous.
const NAME_TOKEN = '\u0000'

// Why: a local removal returns in milliseconds, so show the spinner only once the call is slow
// enough to read as one — a remote host, not a flicker (docs/STYLEGUIDE.md).
const REMOVING_SPINNER_DELAY_MS = 200

const RemoveFolderDialog = React.memo(function RemoveFolderDialog() {
  const activeModal = useAppStore((s) => s.activeModal)
  const modalData = useAppStore((s) => s.modalData)
  const closeModal = useAppStore((s) => s.closeModal)
  const removeProject = useAppStore((s) => s.removeProject)

  const isOpen = activeModal === 'confirm-remove-folder'
  const repoId = typeof modalData.repoId === 'string' ? modalData.repoId : ''
  const displayName = typeof modalData.displayName === 'string' ? modalData.displayName : ''
  const hostId =
    typeof modalData.hostId === 'string' ? normalizeExecutionHostId(modalData.hostId) : null

  // Why: no answer arrived from the owning host on the first attempt, so what it did is unknown.
  // The dialog stays open on that answer and re-offers the removal as a client-only forget.
  const [ownerUnverifiable, setOwnerUnverifiable] = useState(false)
  const [isRemoving, setIsRemoving] = useState(false)
  const [showRemovingSpinner, setShowRemovingSpinner] = useState(false)
  // Why: Cancel stays live while the host is being asked, and this dialog unmounts when the modal
  // closes. Bumping on teardown fences a late answer out of the invocation that replaced it.
  const removalTokenRef = useRef(0)
  useEffect(() => {
    setOwnerUnverifiable(false)
    setIsRemoving(false)
    return () => {
      removalTokenRef.current += 1
    }
  }, [isOpen, repoId, hostId])

  useEffect(() => {
    if (!isRemoving) {
      setShowRemovingSpinner(false)
      return
    }
    const timer = window.setTimeout(() => setShowRemovingSpinner(true), REMOVING_SPINNER_DELAY_MS)
    return () => window.clearTimeout(timer)
  }, [isRemoving])

  // Why: for an SSH project the files live on the remote host's disk, not the
  // user's — "still on your disk" would be misleading. Name the host (using the
  // removed-target label when it's a ghost) so the user knows where it remains
  // and that re-adding that host recovers it.
  const sshConnectionId = useAppStore(
    (s) =>
      s.repos
        .find((repo) => repo.id === repoId && (!hostId || getRepoExecutionHostId(repo) === hostId))
        ?.connectionId?.trim() ?? null
  )
  const sshHostLabel = useAppStore((s) => {
    if (!sshConnectionId) {
      return null
    }
    return (
      s.sshTargetLabels.get(sshConnectionId) ??
      s.removedSshTargetLabels.get(sshConnectionId) ??
      sshConnectionId
    )
  })
  // Why: removeProject addresses exactly the opener's hostId, so that is the host the copy names.
  const resolvedOwnerLabel = useAppStore((s) => {
    if (!hostId) {
      return null
    }
    const label = selectExecutionHostDisplayLabel(s, hostId)
    const parsed = parseExecutionHostId(hostId)
    // Why: with the environment record gone — the very case this copy describes — the resolver
    // answers the routing id itself, and a slug like `env-a1b2` names nothing to the user.
    return parsed?.kind === 'runtime' && label === parsed.environmentId ? null : label
  })
  const ownerLabel =
    resolvedOwnerLabel ??
    translate('auto.components.sidebar.RemoveFolderDialog.unnamedOwnerHost', 'that host')

  // Why: the client-only forget goes through repos.removeForHost, which a paired web client does
  // not implement — it has one runtime and no records of its own to clear. Offering the button
  // there would guarantee a failure, so that client gets the explanation without the action.
  const canForgetLocally = !isPairedWebClientWindow()

  const onRecipeVmServer = useAppStore(
    (s) =>
      getRecipeVmSshTargetForHost(s.runtimeEnvironments, hostId) !== null ||
      (selectWorktreesByRepo(s)[repoId] ?? []).some(
        (worktree) =>
          worktree.hostId === hostId && worktree.ephemeralVmCheckoutMode === 'provisioned-root'
      )
  )

  const worktreesByRepo = useAppStore((s) => selectWorktreesByRepo(s))
  const detectedWorktreesByRepo = useAppStore((s) => selectDetectedWorktreesByRepo(s))
  const unsavedTargets = useMemo(
    () =>
      projectRemovalTargets(
        { worktreesByRepo, detectedWorktreesByRepo },
        repoId ? [{ repoId, hostId }] : []
      ),
    [detectedWorktreesByRepo, hostId, repoId, worktreesByRepo]
  )

  const openTerminalCount = useAppStore((s) =>
    repoId && hostId ? countOpenRepoTerminalTabs(s, repoId, hostId) : 0
  )
  const openTerminalWarning =
    openTerminalCount === 0
      ? null
      : openTerminalCount === 1
        ? translate(
            'auto.components.sidebar.RemoveFolderDialog.openTerminalWarningOne',
            '1 open terminal in this project will be closed.'
          )
        : translate(
            'auto.components.sidebar.RemoveFolderDialog.openTerminalWarningMany',
            '{{count}} open terminals in this project will be closed.',
            { count: openTerminalCount }
          )

  // Why: fragment concatenation around the styled name cannot be reordered by
  // SOV locales (#9294). Translate one full sentence with the name as a
  // sentinel token, then split on it to re-apply the inline emphasis.
  const description = ownerUnverifiable
    ? canForgetLocally
      ? translate(
          'auto.components.sidebar.RemoveFolderDialog.removeDescriptionOwnerUnverifiable',
          'Orca could not reach {{host}}, so whether {{name}} was removed there is unknown — the request may never have arrived, or it may have been carried out and the reply lost. Removing it now clears this computer’s records only and sends nothing to {{host}}; if the project is still registered there, it comes back when that host reconnects.',
          { name: NAME_TOKEN, host: ownerLabel }
        )
      : translate(
          'auto.components.sidebar.RemoveFolderDialog.removeDescriptionOwnerUnverifiableWeb',
          'Orca could not reach {{host}}, so whether {{name}} was removed there is unknown — the request may never have arrived, or it may have been carried out and the reply lost. This client keeps no records of its own to clear, so reconnect {{host}} and try again.',
          { name: NAME_TOKEN, host: ownerLabel }
        )
    : onRecipeVmServer || isRuntimeOwnedSshTargetId(sshConnectionId)
      ? translate(
          'auto.components.sidebar.RemoveFolderDialog.removeDescriptionVmRecipe',
          'This removes {{name}} from Orca. Its VM recipe determines whether the environment and its files are permanently deleted.',
          { name: NAME_TOKEN }
        )
      : sshHostLabel
        ? translate(
            'auto.components.sidebar.RemoveFolderDialog.removeDescriptionSsh',
            'This only removes {{name}} from Orca. Its files stay on {{host}} — re-add that SSH host to recover it.',
            { name: NAME_TOKEN, host: sshHostLabel }
          )
        : translate(
            'auto.components.sidebar.RemoveFolderDialog.removeDescriptionLocal',
            'This only removes {{name}} from Orca. It is still on your disk.',
            { name: NAME_TOKEN }
          )
  const [descriptionBeforeName, descriptionAfterName] = description.split(NAME_TOKEN)

  const handleConfirm = useCallback(async () => {
    // Why: without the opener's host a bare id could remove another host's row (#13071).
    if (!repoId || !hostId) {
      closeModal()
      return
    }
    const token = removalTokenRef.current
    setIsRemoving(true)
    const outcome = await removeProject(repoId, {
      hostId,
      errorFeedback: 'toast',
      confirmedDiscards: confirmUnsavedDiscard(useAppStore.getState, unsavedTargets),
      ...(ownerUnverifiable ? { mode: 'forget-local' as const } : {})
    })
    // Why: this invocation was cancelled or replaced while the host was being asked. closeModal is
    // global, so acting now would dismiss whichever dialog the user opened next.
    if (token !== removalTokenRef.current) {
      return
    }
    setIsRemoving(false)
    // Why: an unanswered host is not a failure to report and not a removal to celebrate — keep
    // the dialog open so the only honest remaining action is the one the user now sees.
    if (outcome.status === 'owner-unverifiable') {
      setOwnerUnverifiable(true)
      return
    }
    closeModal()
  }, [closeModal, hostId, ownerUnverifiable, removeProject, repoId, unsavedTargets])

  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (!open) {
        closeModal()
      }
    },
    [closeModal]
  )

  return (
    <Dialog open={isOpen} onOpenChange={handleOpenChange}>
      <DialogContent surface="security" className="max-w-sm sm:max-w-sm" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle className="text-sm">
            {translate('auto.components.sidebar.RemoveFolderDialog.b79b39d865', 'Remove Project')}
          </DialogTitle>
          <DialogDescription className="text-xs">
            {descriptionBeforeName}
            <span className="break-all font-medium text-foreground">{displayName}</span>
            {descriptionAfterName}
          </DialogDescription>
          {openTerminalWarning ? (
            <p className="text-xs font-medium text-foreground">{openTerminalWarning}</p>
          ) : null}
        </DialogHeader>
        <RemovalUnsavedFilesNotice targets={unsavedTargets} enabled={isOpen} />
        <DialogFooter>
          <Button variant="outline" onClick={() => handleOpenChange(false)}>
            {translate('auto.components.sidebar.RemoveFolderDialog.d36883e046', 'Cancel')}
          </Button>
          {ownerUnverifiable && !canForgetLocally ? null : (
            <Button
              variant="destructive"
              disabled={isRemoving}
              onClick={() => void handleConfirm()}
            >
              {showRemovingSpinner ? <Loader2 className="size-3.5 animate-spin" /> : null}
              {ownerUnverifiable
                ? translate(
                    'auto.components.sidebar.RemoveFolderDialog.removeFromOrcaOnly',
                    'Remove from Orca'
                  )
                : translate('auto.components.sidebar.RemoveFolderDialog.4dc5b5065b', 'Remove')}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
})

export default RemoveFolderDialog
