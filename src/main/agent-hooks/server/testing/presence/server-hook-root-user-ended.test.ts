import { describe, expect, it, vi } from 'vitest'
import { PANE } from '../server.test-fixtures'
import {
  CLAUDE,
  TMUX,
  TMUX_HINT,
  createServer,
  hook,
  registerRootTestHarness,
  runningPane,
  settled,
  slowRoot
} from './server-hook-root.test-fixtures'

vi.mock('../../../../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../../../../telemetry/cohort-classifier', () => ({ getCohortAtEmit: () => ({}) }))
vi.mock('../../../../../shared/agent-status/process/agent-process-presence-probe', () => ({
  probeAgentProcessPresence: vi.fn()
}))

registerRootTestHarness()

const notLive = (): boolean => false

// LOCAL: upstream retires a pane only on a proven process, but the user's word is enough for #30,
// and a row left behind would resume the session they quit once the pane's terminal is lost.
describe('a session the user ended on a row with no recorded process', () => {
  it('retires a Claude in a tmux session the pane does not show', async () => {
    const server = await createServer()
    runningPane(101, ...TMUX)
    const sender = { session: 'tmux', pid: 4043, tmuxPane: TMUX_HINT }
    await hook(server, 'UserPromptSubmit', { ...sender, prompt: 'In tmux' })
    await hook(server, 'Stop', sender)
    expect(server.selectTerminalLossResume(PANE, notLive)).toMatchObject({ agent: 'claude' })

    await hook(server, 'SessionEnd', { ...sender, reason: 'prompt_input_exit' })

    expect(server.exits).toBe(1)
    expect(server.row()).toBeUndefined()
    expect(server.selectTerminalLossResume(PANE, notLive)).toBeNull()
  })

  it('retires it once, ahead of a root read that has not answered', async () => {
    const server = await createServer()
    runningPane(49969, CLAUDE)
    const release = slowRoot()
    await hook(server, 'UserPromptSubmit', {
      session: 'session-a',
      prompt: 'Task',
      tmuxPane: TMUX_HINT
    })

    await hook(server, 'SessionEnd', { session: 'session-a', reason: 'prompt_input_exit' })
    expect(server.exits).toBe(1)
    expect(server.row()).toBeUndefined()

    release()
    await settled()
    expect(server.exits).toBe(1)
    expect(server.selectTerminalLossResume(PANE, notLive)).toBeNull()
  })
})
