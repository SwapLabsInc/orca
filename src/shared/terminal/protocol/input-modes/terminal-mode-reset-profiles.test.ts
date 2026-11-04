import { Terminal } from '@xterm/headless'
import { describe, expect, it } from 'vitest'
import {
  POST_REPLAY_MODE_RESET,
  PROCESS_BOUNDARY_GROUND,
  buildKittyKeyboardRestore,
  buildPostReplayLiveAgentReattachReset
} from './terminal-mode-reset-profiles'
import { TerminalKittyKeyboardModeTracker } from './terminal-kitty-keyboard-mode-tracker'

// Consumers import these bytes; literal expectations catch modes silently disappearing.
describe('terminal mode reset profiles', () => {
  it("clears a dead TUI's alternate-screen kitty flags for the next alternate-screen app", async () => {
    const term = new Terminal({ allowProposedApi: true, vtExtensions: { kittyKeyboard: true } })
    const replies: string[] = []
    term.onData((data) => replies.push(data))
    const write = (data: string): Promise<void> =>
      new Promise((resolve) => term.write(data, resolve))
    await write(`\x1b[?1049h\x1b[>7u\x1b[>1u${PROCESS_BOUNDARY_GROUND}\x1b[?1049h`)
    // Query, then pop once and query again: an empty stack pops to 0.
    await write('\x1b[?u\x1b[<1u\x1b[?u')
    expect(replies).toEqual(['\x1b[?0u', '\x1b[?0u'])
    term.dispose()
  })

  // Why both profiles: after a host restart the daemon appends PROCESS_BOUNDARY_GROUND to the
  // cold-restore payload and its seed, and the renderer writes POST_REPLAY_MODE_RESET after
  // replaying that payload. Each on its own must leave the fresh shell's xterm with no mouse
  // tracking, or every pointer move types `35;x;yM` into the prompt.
  it.each([
    ['PROCESS_BOUNDARY_GROUND', PROCESS_BOUNDARY_GROUND],
    ['POST_REPLAY_MODE_RESET', POST_REPLAY_MODE_RESET]
  ])('%s disarms the input modes a dead normal-screen program left on', async (_name, reset) => {
    const term = new Terminal({ allowProposedApi: true })
    const write = (data: string): Promise<void> =>
      new Promise((resolve) => term.write(data, resolve))
    await write('$ claude\r\n\x1b[?1003h\x1b[?1006h\x1b[?1004h\x1b[?2004h\x1b[?1hthinking…')
    expect(term.modes.mouseTrackingMode).toBe('any')
    expect(term.modes.sendFocusMode).toBe(true)

    await write(reset)
    await write('$ ')

    expect(term.modes.mouseTrackingMode).toBe('none')
    expect(term.modes.sendFocusMode).toBe(false)
    expect(term.modes.bracketedPasteMode).toBe(false)
    expect(term.buffer.active.type).toBe('normal')
    term.dispose()
  })

  describe('live-agent cursor preservation', () => {
    it('omits the cursor-show when the agent left its cursor hidden', () => {
      expect(buildPostReplayLiveAgentReattachReset('x\x1b[?25l')).not.toContain('\x1b[?25h')
      expect(buildPostReplayLiveAgentReattachReset('x\x1b[?25h')).toContain('\x1b[?25h')
    })
  })

  // A replayed push grows xterm’s stack but acts as a mirror set; pop-all prevents the app’s single pop restoring stale flags.
  it("brings xterm and the mirror to 0 on the app's pop after a redelivered push", async () => {
    const term = new Terminal({ allowProposedApi: true, vtExtensions: { kittyKeyboard: true } })
    const mirror = new TerminalKittyKeyboardModeTracker()
    const replies: string[] = []
    term.onData((data) => replies.push(data))
    const write = (data: string): Promise<void> =>
      new Promise((resolve) => term.write(data, resolve))
    const xtermFlags = async (): Promise<string> => {
      replies.length = 0
      await write('\x1b[?u')
      return replies.join('')
    }
    for (const redelivery of ['\x1b[>1u', '\x1b[>1u']) {
      mirror.scanReplay(redelivery)
      await write(redelivery)
    }
    const restore = buildKittyKeyboardRestore(mirror.snapshotFlags)
    mirror.scan(restore)
    await write(restore)
    expect(mirror.flags).toBe(1)
    expect(await xtermFlags()).toBe('\x1b[?1u')

    mirror.scan('\x1b[<u')
    await write('\x1b[<u')
    expect(mirror.flags).toBe(0)
    expect(await xtermFlags()).toBe('\x1b[?0u')
    term.dispose()
  })
})
