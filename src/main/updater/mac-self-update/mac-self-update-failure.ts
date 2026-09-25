/** Why one code per refusal: diagnostics and tests key on it, never on the message text. */
export type MacSelfUpdateFailureReason =
  | 'no-feed'
  | 'manifest-unavailable'
  | 'manifest-malformed'
  | 'signature-invalid'
  | 'source-mismatch'
  | 'arch-mismatch'
  | 'bundle-id-mismatch'
  | 'version-mismatch'
  | 'version-not-newer'
  | 'signing-identity-mismatch'
  | 'running-bundle-unsigned'
  | 'app-location-unwritable'
  | 'download-failed'
  | 'download-size-mismatch'
  | 'download-hash-mismatch'
  | 'extract-failed'
  | 'bundle-signature-invalid'
  | 'bundle-identity-mismatch'
  | 'bundle-version-mismatch'
  | 'nothing-staged'
  | 'helper-launch-failed'
  | 'install-state-unwritable'

/** How an update error should reach the card: a page to fetch the build by hand, and whether retrying can help. */
export type UpdateErrorPresentation = {
  manualInstallUrl?: string
  retryable?: boolean
}

export class MacSelfUpdateError extends Error {
  constructor(
    readonly reason: MacSelfUpdateFailureReason,
    message: string,
    readonly presentation: UpdateErrorPresentation = {}
  ) {
    super(message)
    this.name = 'MacSelfUpdateError'
  }
}

/**
 * Why by shape and not `instanceof`: the error is created by the engine and read by the updater
 * state machine, and test module resets (or any realm boundary) give the two different class objects.
 */
export function isMacSelfUpdateError(error: unknown): error is MacSelfUpdateError {
  return (
    error instanceof Error &&
    error.name === 'MacSelfUpdateError' &&
    'reason' in error &&
    typeof error.reason === 'string' &&
    'presentation' in error &&
    typeof error.presentation === 'object'
  )
}

/** Reads the card presentation off an error, or nothing for errors that carry none. */
export function readUpdateErrorPresentation(error: unknown): UpdateErrorPresentation {
  if (!isMacSelfUpdateError(error)) {
    return {}
  }
  return {
    ...(error.presentation.manualInstallUrl
      ? { manualInstallUrl: error.presentation.manualInstallUrl }
      : {}),
    ...(error.presentation.retryable === undefined
      ? {}
      : { retryable: error.presentation.retryable })
  }
}
