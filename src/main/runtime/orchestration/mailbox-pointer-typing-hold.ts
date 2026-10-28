import type { TerminalTypedInput } from '../terminal-run-facts'

/** Keys this recent mean the user is typing to the agent now. */
export const POINTER_TYPING_QUIET_MS = 4_000

/** How long after its last key an unsent draft holds the pointer: long enough for a pause to think
 *  mid-prompt, short enough that keys misread as a draft (Backspace to empty, Esc, a dialog's number
 *  key) delay mail by at most this. A draft the screen still shows is held up to
 *  USER_INPUT_HOLD_CAP_MS by the composer check instead. */
export const POINTER_UNSUBMITTED_DRAFT_HOLD_MS = 2 * 60_000

/** Whether typing the pointer now would land in what the user is typing to the agent. */
export function isUserTypingToPointerTarget(
  input: Readonly<TerminalTypedInput> | null,
  now: number
): boolean {
  const sinceLastKey = input ? now - input.at : -1
  // A clock stepped back past the last key proves nothing either way; deliver as without the signal.
  if (!input || sinceLastKey < 0) {
    return false
  }
  return (
    sinceLastKey < POINTER_TYPING_QUIET_MS ||
    (input.unsubmitted && sinceLastKey <= POINTER_UNSUBMITTED_DRAFT_HOLD_MS)
  )
}

/** Whether keys reached the PTY after the pointer text did; they now share its composer. */
export function hasTypedSincePointerWrite(
  currentSerial: number | null,
  serialAtWrite: number | undefined
): boolean {
  return currentSerial !== null && currentSerial > (serialAtWrite ?? 0)
}
