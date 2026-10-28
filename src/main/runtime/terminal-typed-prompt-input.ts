// Why built from escaped strings: keep literal control bytes out of source.
const MOUSE_REPORTS_ONLY_RE = new RegExp(
  // oxlint-disable-next-line no-control-regex -- mouse reports are ESC-framed sequences by definition.
  '^(?:\\u001b\\[<[0-9]+;[0-9]+;[0-9]+[Mm]|\\u001b\\[M[\\s\\S]{3})+$'
)
// oxlint-disable-next-line no-control-regex -- Ctrl+U and Ctrl+K are the agent TUIs' clear-input keys.
const CLEAR_INPUT_ONLY_RE = new RegExp('^[\\u000b\\u0015]+$')

/** How typed bytes leave an agent's unsent prompt: `submit` sends or clears it, `edit` may leave
 *  text in it, null (mouse reports) does not touch it. */
export function typedPromptInputEffect(data: string): 'submit' | 'edit' | null {
  if (data.length === 0 || MOUSE_REPORTS_ONLY_RE.test(data)) {
    return null
  }
  if (CLEAR_INPUT_ONLY_RE.test(data) || data.endsWith('\x03')) {
    return 'submit'
  }
  // Why not LF or ESC CR: agent composers insert a newline for Ctrl+J and Meta/Shift+Enter.
  return data.endsWith('\r') && data.at(-2) !== '\x1b' ? 'submit' : 'edit'
}
