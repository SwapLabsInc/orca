import { extractAgentProviderSession } from '../../agent-session-resume'
import type { ParsedHookEnvelope } from '../hook-envelope'
import { readFirstString } from '../interactive-tool'
import { readString } from '../tool-input-preview'

// Why an allowlist: Claude reports `other` when a signal ends it, which is how a lost terminal
// looks. `clear` needs nothing here: the SessionStart that follows it replaces the pane's session.
// `bypass_permissions_disabled` is Claude quitting a mode it may not run in; resuming it would
// only quit again.
const USER_ENDED_CLAUDE_SESSION_REASONS: ReadonlySet<string> = new Set([
  'prompt_input_exit',
  'logout',
  'bypass_permissions_disabled'
])

/** The session a Claude `SessionEnd` hook says the user ended, or null for any other hook. */
export function readClaudeUserEndedSessionId(envelope: ParsedHookEnvelope): string | null {
  const { record, hookPayloadRecord } = envelope
  const eventName =
    readFirstString(record, ['hook_event_name', 'hookEventName', 'hook_type', 'hookType']) ??
    readString(hookPayloadRecord, 'hook_event_name') ??
    readString(hookPayloadRecord, 'hookEventName')
  if (eventName !== 'SessionEnd' || readString(hookPayloadRecord, 'agent_id') !== undefined) {
    return null
  }
  const reason = readString(hookPayloadRecord, 'reason')
  if (!reason || !USER_ENDED_CLAUDE_SESSION_REASONS.has(reason)) {
    return null
  }
  return extractAgentProviderSession('claude', hookPayloadRecord)?.id ?? null
}
