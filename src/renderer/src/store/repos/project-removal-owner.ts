import {
  getRepoExecutionHostId,
  isRuntimeOwnedSshTargetId,
  LOCAL_EXECUTION_HOST_ID,
  type ExecutionHostId
} from '../../../../shared/execution-host'
import type { Repo } from '../../../../shared/repo-types'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import { getRecipeVmSshTargetForHost } from '@/lib/recipe-vm-managed-host'
import { ipcOrRuntimeTargetForHostId } from '../../runtime/runtime-client-target'
import type { AppState } from '../types'
import { selectWorktreesByRepo } from '../workspace-record-selectors'
import { isOwnerContactFailure, type RemoveProjectOutcome } from './project-removal-outcome'
import { destroyRecipeVmBeforeProjectRemoval } from './recipe-vm-project-removal'
import type { RepoSlice } from './repo-state'

type RemovalMode = Parameters<RepoSlice['removeProject']>[1]['mode']
type VmRemovalState = Pick<AppState, 'runtimeEnvironments' | 'worktreesByRepo'>

/**
 * Where a project removal sends its host call. A forget clears this client's records only, so it
 * takes the host-scoped local call even for a paired server: that host gets no terminal stop or
 * `repo.rm`, and what it holds stays whatever it held before — unknown after a lost answer.
 */
export function removalTarget(
  ownerHostId: ExecutionHostId,
  mode: RemovalMode
): RuntimeClientTarget {
  const target = ipcOrRuntimeTargetForHostId(ownerHostId)
  if (!target) {
    throw new Error('The project host is unresolved. Refresh and retry.')
  }
  return mode === 'forget-local' ? { kind: 'local' } : target
}

/**
 * Destroys the recipe VM behind a project before its removal, except for a forget: that removal
 * exists to destroy the VM and a forget touches nothing outside this client, so both cannot hold —
 * refuse rather than leak a live VM or quietly break the promise.
 */
export function vmDestroyUnlessForget(
  state: VmRemovalState,
  ownerRepo: Repo,
  mode: RemovalMode,
  workspaceIds: string[]
): Promise<boolean> | false {
  const ownerHostId = getRepoExecutionHostId(ownerRepo)
  if (mode !== 'forget-local') {
    return destroyRecipeVmBeforeProjectRemoval(state, ownerRepo, ownerHostId, workspaceIds)
  }
  if (recipeVmBacksProject(state, ownerRepo, ownerHostId)) {
    throw new Error(
      'This project runs on a cloud VM, so it can only be removed by destroying that VM.'
    )
  }
  return false
}

// Why: destroyRecipeVmBeforeProjectRemoval's synchronous signals, read without destroying.
function recipeVmBacksProject(
  state: VmRemovalState,
  ownerRepo: Repo,
  ownerHostId: ExecutionHostId
): boolean {
  return (
    getRecipeVmSshTargetForHost(state.runtimeEnvironments, ownerHostId) !== null ||
    isRuntimeOwnedSshTargetId(ownerRepo.connectionId) ||
    (selectWorktreesByRepo(state)[ownerRepo.id] ?? []).some(
      (worktree) =>
        (worktree.hostId ?? LOCAL_EXECUTION_HOST_ID) === ownerHostId &&
        worktree.ephemeralVmCheckoutMode === 'provisioned-root'
    )
  )
}

/**
 * A host call that failed without an answer: whether the host removed the project is unknown, so
 * purging would assert an outcome nobody observed. Report it so the caller can offer the
 * client-only forget (docs/reference/ssh-execution-boundary.md); a host that answered and refused
 * is rethrown as a failure.
 */
export function unansweredOrThrow(
  target: RuntimeClientTarget,
  error: unknown
): RemoveProjectOutcome {
  if (target.kind === 'environment' && isOwnerContactFailure(error)) {
    return { status: 'owner-unverifiable' }
  }
  throw error
}
