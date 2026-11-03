import { describe, expect, it } from 'vitest'
import { resolvePaneScopedLaunchTuiAgent } from './pane-agent-evidence'

describe('resolvePaneScopedLaunchTuiAgent', () => {
  it("has no tab-wide source at all, so a sibling pane's identity cannot leak in", () => {
    expect(resolvePaneScopedLaunchTuiAgent({})).toBeNull()
  })

  it("accepts this pane's own hook status row", () => {
    expect(resolvePaneScopedLaunchTuiAgent({ statusEntryAgent: 'claude' })).toBe('claude')
  })

  it('prefers the pane startup over weaker pane-scoped readings', () => {
    expect(
      resolvePaneScopedLaunchTuiAgent({
        paneStartupLaunchAgent: 'codex',
        statusEntryAgent: 'claude'
      })
    ).toBe('codex')
  })

  it('skips a reading that names no known TUI agent', () => {
    expect(
      resolvePaneScopedLaunchTuiAgent({
        paneStartupLaunchAgent: 'bash',
        statusEntryAgent: 'claude'
      })
    ).toBe('claude')
  })
})
