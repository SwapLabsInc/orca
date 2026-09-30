import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

/**
 * A stand-in `claude` for agent-resume journeys: it records every launch's argv, posts the Claude
 * hook events a real session posts to the pane's own hook endpoint, and paints like a TUI.
 *
 * - A fresh launch picks a session id from its pane key, so two panes get two sessions; `--resume
 *   <id>` reuses the id it was given and posts `SessionStart(source: resume)`.
 * - `FAKE_CLAUDE_MODE=working` stops before `Stop`, leaving the pane mid-turn.
 * - A fresh launch arms SGR mouse reporting like a full-screen TUI; a resumed one does not, so a
 *   pane still reporting the mouse afterwards is reporting for the process that died.
 * - Ctrl+D ends the session the way `/exit` does: `SessionEnd(prompt_input_exit)`, then exit.
 * - It posts nothing without `FAKE_CLAUDE_STATE_DIR`, which only the host under test carries.
 */
const FAKE_CLAUDE_SOURCE = String.raw`#!/usr/bin/env node
const args = process.argv.slice(2)
if (args.some((a) => a === '--version' || a === '-v' || a === '--help' || a === '-h')) {
  process.stdout.write('2.1.300 (fake-claude)\n')
  process.exit(0)
}
const fs = require('node:fs')
const path = require('node:path')
const http = require('node:http')
const crypto = require('node:crypto')
const stateDir = process.env.FAKE_CLAUDE_STATE_DIR
const paneKey = process.env.ORCA_PANE_KEY || ''
const resumeIndex = args.indexOf('--resume')
const resumedId = resumeIndex >= 0 ? args[resumeIndex + 1] : null
const sessionId =
  resumedId || 'fake-' + crypto.createHash('sha256').update(paneKey).digest('hex').slice(0, 16)
const mode = process.env.FAKE_CLAUDE_MODE === 'working' ? 'working' : 'idle'
if (stateDir) {
  fs.appendFileSync(
    path.join(stateDir, 'argv.jsonl'),
    JSON.stringify({ at: Date.now(), pid: process.pid, argv: args, paneKey, sessionId }) + '\n'
  )
}
function post(eventName, extra) {
  const port = Number(process.env.ORCA_AGENT_HOOK_PORT || 0)
  const token = process.env.ORCA_AGENT_HOOK_TOKEN || ''
  if (!stateDir || !port || !token || !paneKey) return Promise.resolve()
  const body = JSON.stringify({
    paneKey,
    tabId: process.env.ORCA_TAB_ID || '',
    worktreeId: process.env.ORCA_WORKTREE_ID || '',
    launchToken: process.env.ORCA_AGENT_LAUNCH_TOKEN || '',
    env: process.env.ORCA_AGENT_HOOK_ENV || '',
    version: process.env.ORCA_AGENT_HOOK_VERSION || '',
    payload: {
      hook_event_name: eventName,
      session_id: sessionId,
      transcript_path: path.join(stateDir, sessionId + '.jsonl'),
      cwd: process.cwd(),
      ...(extra || {})
    }
  })
  return new Promise((resolve) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method: 'POST',
        path: '/hook/claude',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          'X-Orca-Agent-Hook-Token': token
        }
      },
      (res) => {
        fs.appendFileSync(
          path.join(stateDir, 'hooks.jsonl'),
          JSON.stringify({ at: Date.now(), eventName, sessionId, paneKey, status: res.statusCode }) + '\n'
        )
        res.resume()
        res.on('end', resolve)
      }
    )
    req.on('error', () => resolve())
    req.end(body)
  })
}
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
let exiting = false
async function exit(reason) {
  if (exiting) return
  exiting = true
  await post('SessionEnd', { reason })
  process.stdout.write('\x1b[?1006l\x1b[?1000l')
  process.exit(0)
}
async function main() {
  process.stdout.write('FAKE_CLAUDE_READY session=' + sessionId + ' resumed=' + (resumedId ? 'yes' : 'no') + '\r\n')
  if (process.stdin.isTTY) process.stdin.setRawMode(true)
  process.stdin.on('data', (chunk) => {
    if (chunk.includes(4)) void exit('prompt_input_exit')
  })
  process.stdin.resume()
  for (const signal of ['SIGHUP', 'SIGTERM', 'SIGINT']) process.on(signal, () => void exit('other'))
  await post('SessionStart', { source: resumedId ? 'resume' : 'startup' })
  if (resumedId) {
    process.stdout.write('FAKE_CLAUDE_RESUMED\r\n')
    return
  }
  await pause(200)
  await post('UserPromptSubmit', { prompt: 'do the thing' })
  await pause(200)
  await post('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'ls' } })
  await pause(200)
  if (mode === 'idle') {
    await post('Stop', { last_assistant_message: 'done with the thing', stop_hook_active: false })
  }
  process.stdout.write('\x1b[?1000h\x1b[?1006h')
  process.stdout.write((mode === 'idle' ? 'FAKE_CLAUDE_IDLE' : 'FAKE_CLAUDE_WORKING') + '\r\n')
}
void main()
`

export type FakeClaudeLaunch = {
  at: number
  pid: number
  argv: string[]
  paneKey: string
  sessionId: string
}

export type FakeClaudeHookPost = {
  eventName: string
  sessionId: string
  paneKey: string
  status: number
}

export type FakeClaudeAgent = {
  /** Directory to put first on the host's PATH. */
  binDir: string
  /** Host env that arms the fake; without it the fake posts nothing. */
  env: (mode: 'idle' | 'working') => Record<string, string>
  launches: () => FakeClaudeLaunch[]
  hookPosts: () => FakeClaudeHookPost[]
}

function readJsonLines(file: string): Record<string, unknown>[] {
  if (!existsSync(file)) {
    return []
  }
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .flatMap((line) => {
      const value: unknown = JSON.parse(line)
      return typeof value === 'object' && value !== null && !Array.isArray(value)
        ? [Object.fromEntries(Object.entries(value))]
        : []
    })
}

const text = (value: unknown): string => (typeof value === 'string' ? value : '')
const count = (value: unknown): number => (typeof value === 'number' ? value : 0)

function toLaunch(record: Record<string, unknown>): FakeClaudeLaunch {
  return {
    at: count(record.at),
    pid: count(record.pid),
    argv: Array.isArray(record.argv) ? record.argv.map(text) : [],
    paneKey: text(record.paneKey),
    sessionId: text(record.sessionId)
  }
}

function toHookPost(record: Record<string, unknown>): FakeClaudeHookPost {
  return {
    eventName: text(record.eventName),
    sessionId: text(record.sessionId),
    paneKey: text(record.paneKey),
    status: count(record.status)
  }
}

export function installFakeClaudeAgent(root: string): FakeClaudeAgent {
  const binDir = path.join(root, 'bin')
  const stateDir = path.join(root, 'state')
  mkdirSync(binDir, { recursive: true })
  mkdirSync(stateDir, { recursive: true })
  const executable = path.join(binDir, 'claude')
  writeFileSync(executable, FAKE_CLAUDE_SOURCE)
  chmodSync(executable, 0o755)
  return {
    binDir,
    env: (mode) => ({
      PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}`,
      FAKE_CLAUDE_STATE_DIR: stateDir,
      FAKE_CLAUDE_MODE: mode
    }),
    launches: () => readJsonLines(path.join(stateDir, 'argv.jsonl')).map(toLaunch),
    hookPosts: () => readJsonLines(path.join(stateDir, 'hooks.jsonl')).map(toHookPost)
  }
}
