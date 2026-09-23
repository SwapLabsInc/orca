import {
  isRecoverableRemoteRuntimeConnectionError,
  toRemoteRuntimeClientErrorLike
} from '../../../../shared/remote-runtime-client-error-classification'

/**
 * What `removeProject` actually did.
 *
 * `owner-unverifiable` is its own answer, not a flavour of failure: the owning host never
 * answered, so its catalog is untouched and the project is still registered there. Loss of
 * contact is never evidence of absence (docs/reference/ssh-execution-boundary.md), so a caller
 * must not report the project as removed — it may instead offer the client-only forget, which
 * clears Orca's records here and claims nothing about the host.
 */
export type RemoveProjectOutcome =
  | { status: 'removed' }
  | { status: 'owner-unverifiable' }
  | { status: 'failed' }

/**
 * True only when the owning host never answered. A host that answers and refuses — unauthorized,
 * protocol mismatch, an error from its own catalog — is positive evidence and stays a failure.
 */
export function isOwnerContactFailure(error: unknown): boolean {
  return isRecoverableRemoteRuntimeConnectionError(toRemoteRuntimeClientErrorLike(error))
}
