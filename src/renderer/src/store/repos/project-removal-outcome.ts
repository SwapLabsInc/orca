import {
  isRecoverableRemoteRuntimeConnectionError,
  toRemoteRuntimeClientErrorLike
} from '../../../../shared/remote-runtime-client-error-classification'

/**
 * What `removeProject` actually did.
 *
 * `owner-unverifiable` is its own answer, not a flavour of failure: no answer arrived from the
 * owning host, so what that host did is **unknown**. It may never have seen the request, or it may
 * have removed the project and lost the reply past the timeout. Neither reading may be asserted
 * (docs/reference/ssh-execution-boundary.md), so a caller must not report the project as removed,
 * must not claim the host still holds it, and must keep its own row — a purge here would state an
 * outcome nobody observed. The one honest action left is the client-only forget, which clears
 * Orca's records and says nothing about the host either way.
 *
 * Retrying once the host answers is safe: `repo.rm` reporting `repo_not_found` is tolerated, so a
 * removal that did land is reconciled instead of failing the second attempt.
 */
export type RemoveProjectOutcome =
  | { status: 'removed' }
  | { status: 'owner-unverifiable' }
  | { status: 'failed' }

/**
 * True only when no answer reached us — a dropped transport, a timeout, an unreachable runtime.
 * A host that answers and refuses — unauthorized, protocol mismatch, an error from its own
 * catalog — is positive evidence and stays a failure.
 */
export function isOwnerContactFailure(error: unknown): boolean {
  return isRecoverableRemoteRuntimeConnectionError(toRemoteRuntimeClientErrorLike(error))
}
