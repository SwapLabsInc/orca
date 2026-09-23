import type { AppState } from '../types'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import {
  agentProviderSessionsEqual,
  getAgentResumeArgv,
  isResumableTuiAgent,
  type AgentProviderSessionMetadata,
  type SleepingAgentLaunchConfig,
  type SleepingAgentSessionRecord
} from '../../../../shared/agent-session-resume'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import { findTabForAgentEntry } from './agent-status-pane-key-tab-binding'

export function copyLaunchConfig(config: SleepingAgentLaunchConfig): SleepingAgentLaunchConfig {
  return {
    ...(config.agentCommand ? { agentCommand: config.agentCommand } : {}),
    agentArgs: config.agentArgs,
    agentEnv: { ...config.agentEnv },
    ...(config.ompResumeFilePath ? { ompResumeFilePath: config.ompResumeFilePath } : {})
  }
}

/** Omission is not evidence. `interrupted` is refreshed from every payload, so a payload that says
 *  nothing about it must not clear a prior marker — the row then reads as passive hibernation and
 *  the resume path clears it instead of resuming. Cleared only on an explicit negative, and
 *  inherited only from a record that names the same session this entry does (EP-STATE). */
function resolveInterruptedMarker(
  entry: AgentStatusEntry,
  priorRecord: SleepingAgentSessionRecord | undefined
): boolean {
  if (entry.interrupted !== undefined) {
    return entry.interrupted
  }
  if (!priorRecord || !entry.providerSession || entry.agentType !== priorRecord.agent) {
    return false
  }
  return (
    priorRecord.interrupted === true &&
    agentProviderSessionsEqual(
      priorRecord.agent,
      priorRecord.providerSession,
      entry.providerSession
    )
  )
}

export function sleepingRecordFromEntry(args: {
  state: AppState
  entry: AgentStatusEntry
  worktreeId: string
  tab?: TerminalTab
  capturedAt: number
  launchConfig?: SleepingAgentLaunchConfig
  origin?: SleepingAgentSessionRecord['origin']
  /** The record this build replaces, so an omitted `interrupted` keeps its established marker. */
  priorRecord?: SleepingAgentSessionRecord
}): SleepingAgentSessionRecord | null {
  const agent = args.entry.agentType
  if (
    args.entry.terminalResumeEligible === false ||
    !isResumableTuiAgent(agent) ||
    !args.entry.providerSession
  ) {
    return null
  }
  if (!getAgentResumeArgv(agent, args.entry.providerSession)) {
    return null
  }
  const tab = args.tab ?? findTabForAgentEntry(args.state, args.worktreeId, args.entry)
  return {
    paneKey: args.entry.paneKey,
    ...(tab ? { tabId: tab.id } : {}),
    worktreeId: args.worktreeId,
    agent,
    providerSession: args.entry.providerSession,
    ...(args.entry.connectionId !== undefined ? { connectionId: args.entry.connectionId } : {}),
    prompt: args.entry.prompt,
    state: args.entry.state,
    capturedAt: args.capturedAt,
    updatedAt: args.entry.updatedAt,
    ...((args.entry.terminalTitle ?? tab?.title)
      ? { terminalTitle: (args.entry.terminalTitle ?? tab?.title)! }
      : {}),
    ...(args.entry.lastAssistantMessage
      ? { lastAssistantMessage: args.entry.lastAssistantMessage }
      : {}),
    ...(args.launchConfig ? { launchConfig: copyLaunchConfig(args.launchConfig) } : {}),
    ...(resolveInterruptedMarker(args.entry, args.priorRecord) ? { interrupted: true } : {}),
    ...(args.origin ? { origin: args.origin } : {})
  }
}

// Why positive evidence only: this is the pane's sole resume handle, and a row with no provider
// session (OSC, replay, unhydrated worktree) says nothing about it.
export function shouldRetireSleepingRecord(args: {
  entry: AgentStatusEntry
  existingRecord: SleepingAgentSessionRecord
  /** The build's resolved session, which may be inherited from the live row the payload omitted. */
  providerSession: AgentProviderSessionMetadata | undefined
}): boolean {
  if (args.entry.terminalResumeEligible === false) {
    return true
  }
  // A pane that switched agent has positively moved on; an undefined type is unknown, not changed.
  if (args.entry.agentType !== undefined && args.entry.agentType !== args.existingRecord.agent) {
    return true
  }
  const providerSession = args.providerSession ?? args.entry.providerSession
  if (!providerSession) {
    return false
  }
  // Reached only when this session built no record, so a different id is an unresumable successor.
  return !agentProviderSessionsEqual(
    args.existingRecord.agent,
    args.existingRecord.providerSession,
    providerSession
  )
}

/** Keeps the resume identity; refreshes the volatile fields readers show as live pane state. */
export function refreshRetainedSleepingRecord(
  record: SleepingAgentSessionRecord,
  entry: AgentStatusEntry
): SleepingAgentSessionRecord {
  // Why: a finished pane's handle carries resume identity, not the completed turn's text.
  const prompt = entry.state === 'done' ? '' : entry.prompt
  const lastAssistantMessage = entry.state === 'done' ? undefined : entry.lastAssistantMessage
  // No title means unknown, not cleared.
  const terminalTitle = entry.terminalTitle ?? record.terminalTitle
  // Already established as this record's own session by `shouldRetireSleepingRecord`, so the prior
  // marker carries over directly. See `resolveInterruptedMarker` for why omission cannot clear it.
  const interrupted = entry.interrupted ?? record.interrupted === true
  if (
    record.state === entry.state &&
    record.prompt === prompt &&
    record.updatedAt === entry.updatedAt &&
    record.terminalTitle === terminalTitle &&
    record.lastAssistantMessage === lastAssistantMessage &&
    (record.interrupted === true) === interrupted
  ) {
    return record
  }
  const next: SleepingAgentSessionRecord = {
    ...record,
    state: entry.state,
    prompt,
    updatedAt: entry.updatedAt
  }
  if (terminalTitle === undefined) {
    delete next.terminalTitle
  } else {
    next.terminalTitle = terminalTitle
  }
  if (lastAssistantMessage === undefined) {
    delete next.lastAssistantMessage
  } else {
    next.lastAssistantMessage = lastAssistantMessage
  }
  if (interrupted) {
    next.interrupted = true
  } else {
    delete next.interrupted
  }
  return next
}

export type CollectSleepingAgentSessionRecordsOptions = {
  paneKeys?: readonly string[]
  captureMode?: 'manual-worktree-sleep' | 'completed-agent-hibernation'
}

export function normalizeSleepingAgentSessionCollectOptions(
  options: readonly string[] | CollectSleepingAgentSessionRecordsOptions | undefined
): CollectSleepingAgentSessionRecordsOptions {
  if (!options) {
    return {}
  }
  return Array.isArray(options)
    ? { paneKeys: options }
    : (options as CollectSleepingAgentSessionRecordsOptions)
}

export function isValidCompletedAgentHibernationEntry(entry: AgentStatusEntry): boolean {
  return entry.state === 'done' && entry.interrupted !== true
}

// Why: a finished pane is passive wake evidence, and a mobile wake background-mounts every passive
// record's tab. Sleeping a workspace must not become "one phone tap respawns all of it" — the pane
// issues its own `--resume` cold restore when its tab is opened instead (#11598).
export function markManualSleepLazyRestore(record: SleepingAgentSessionRecord): void {
  if (record.state === 'done') {
    record.restoreOnTabOpenOnly = true
  }
}

// Why: `live`/legacy rows are provisional checkpoints a fresh capture supersedes; an explicit
// sleep or quit capture is the pane's only resume handle once its live row is gone.
export function isDurableSleepingCapture(record: SleepingAgentSessionRecord): boolean {
  return record.origin === 'worktree-sleep' || record.origin === 'quit'
}

// Why: manual sleep kills the pty either way, so the record carries resume identity, not the dead
// turn's interrupt flag — and an explicitly slept workspace is never stale at wake, so a row the
// user is deliberately sleeping must not trip the wake-side staleness discard. `state` is preserved
// so a done pane wakes lazily in place instead of spawning a new tab.
export function manualSleepCaptureEntry(
  entry: AgentStatusEntry,
  capturedAt: number
): AgentStatusEntry {
  return { ...entry, updatedAt: capturedAt, interrupted: false }
}

export function removeSleepingRecordsReplacedByManualWorktreeSleep(
  records: Record<string, SleepingAgentSessionRecord>,
  worktreeId: string,
  paneKeys?: readonly string[],
  replacements?: Readonly<Record<string, SleepingAgentSessionRecord>>
): { records: Record<string, SleepingAgentSessionRecord>; changed: boolean } {
  const allowedPaneKeys = paneKeys ? new Set(paneKeys) : null
  let next = records
  let changed = false
  for (const [paneKey, record] of Object.entries(records)) {
    if (record.worktreeId !== worktreeId || (allowedPaneKeys && !allowedPaneKeys.has(paneKey))) {
      continue
    }
    // Why: a repeat sleep must not delete a durable record this capture cannot re-derive — the
    // pane was never woken, so it has no live status row to rebuild it from (#11598).
    if (!replacements?.[paneKey] && isDurableSleepingCapture(record)) {
      continue
    }
    if (next === records) {
      next = { ...records }
    }
    delete next[paneKey]
    changed = true
  }
  return { records: next, changed }
}
