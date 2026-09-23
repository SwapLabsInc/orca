import React, { useCallback, useEffect, useRef, useState } from 'react'
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
  parseExecutionHostId,
  type ExecutionHostId
} from '../../../../shared/execution-host'
import { selectExecutionHostDisplayLabel } from '@/lib/execution-host-display-label'

// Why: interpolated into the sentence so locales control where the name sits;
// U+0000 cannot appear in a real project name, so the split is unambiguous.
const NAME_TOKEN = '\u0000'

const RemoveFolderDialog = React.memo(function RemoveFolderDialog() {
  const activeModal = useAppStore((s) => s.activeModal)
  const modalData = useAppStore((s) => s.modalData)
  const closeModal = useAppStore((s) => s.closeModal)
  const removeProject = useAppStore((s) => s.removeProject)

  const isOpen = activeModal === 'confirm-remove-folder'
  const repoId = typeof modalData.repoId === 'string' ? modalData.repoId : ''
  const displayName = typeof modalData.displayName === 'string' ? modalData.displayName : ''
  const hostId = typeof modalData.hostId === 'string' ? (modalData.hostId as ExecutionHostId) : null

  // Why: no answer arrived from the owning host on the first attempt, so what it did is unknown.
  // The dialog stays open on that answer and re-offers the removal as a client-only forget.
  const [ownerUnverifiable, setOwnerUnverifiable] = useState(false)
  const [isRemoving, setIsRemoving] = useState(false)
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
  // Only a `runtime:` owner can answer `owner-unverifiable`, so its name is the one the forget
  // copy needs.
  const runtimeOwnerLabel = useAppStore((s) =>
    hostId && parseExecutionHostId(hostId)?.kind === 'runtime'
      ? selectExecutionHostDisplayLabel(s, hostId)
      : null
  )

  // Why: fragment concatenation around the styled name cannot be reordered by
  // SOV locales (#9294). Translate one full sentence with the name as a
  // sentinel token, then split on it to re-apply the inline emphasis.
  const description = ownerUnverifiable
    ? translate(
        'auto.components.sidebar.RemoveFolderDialog.removeDescriptionOwnerUnverifiable',
        'Orca could not reach {{host}}, so whether {{name}} was removed there is unknown. Removing it now only clears this computer’s records — if it is still registered on {{host}}, it returns when that host reconnects.',
        { name: NAME_TOKEN, host: runtimeOwnerLabel ?? '' }
      )
    : isRuntimeOwnedSshTargetId(sshConnectionId)
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
    if (!repoId) {
      closeModal()
      return
    }
    const token = removalTokenRef.current
    setIsRemoving(true)
    const outcome = await removeProject(repoId, {
      ...(hostId ? { hostId } : {}),
      errorFeedback: 'toast',
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
  }, [closeModal, hostId, ownerUnverifiable, removeProject, repoId])

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
      <DialogContent className="max-w-sm sm:max-w-sm" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle className="text-sm">
            {translate('auto.components.sidebar.RemoveFolderDialog.b79b39d865', 'Remove Project')}
          </DialogTitle>
          <DialogDescription className="text-xs">
            {descriptionBeforeName}
            <span className="break-all font-medium text-foreground">{displayName}</span>
            {descriptionAfterName}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => handleOpenChange(false)}>
            {translate('auto.components.sidebar.RemoveFolderDialog.d36883e046', 'Cancel')}
          </Button>
          <Button variant="destructive" disabled={isRemoving} onClick={() => void handleConfirm()}>
            {ownerUnverifiable
              ? translate(
                  'auto.components.sidebar.RemoveFolderDialog.removeFromOrcaOnly',
                  'Remove from Orca'
                )
              : translate('auto.components.sidebar.RemoveFolderDialog.4dc5b5065b', 'Remove')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
})

export default RemoveFolderDialog
