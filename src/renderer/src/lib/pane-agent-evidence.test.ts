import { describe, expect, it } from 'vitest'
import {
  AGENT_STATUS_STALE_AFTER_MS,
  type AgentStatusEntry
} from '../../../shared/agent-status-types'
import {
  classifyTitleActivity,
  isExplicitAgentStatusFresh,
  resolveCommittedTitleAgentType,
  resolvePaneAgentActivity,
  resolvePaneScopedLaunchTuiAgent,
  resolveTitleActivityLabel
} from './pane-agent-evidence'

const NOW = 1_700_000_000_000

function entry(overrides: Partial<AgentStatusEntry> = {}): AgentStatusEntry {
  return {
    paneKey: 'tab-1:leaf-1',
    agentType: 'claude',
    state: 'working',
    prompt: '',
    updatedAt: NOW,
    stateStartedAt: NOW,
    stateHistory: [],
    ...overrides
  } as AgentStatusEntry
}

describe('isExplicitAgentStatusFresh', () => {
  it('accepts an entry exactly at the staleness boundary', () => {
    expect(
      isExplicitAgentStatusFresh(
        { updatedAt: NOW - AGENT_STATUS_STALE_AFTER_MS },
        NOW,
        AGENT_STATUS_STALE_AFTER_MS
      )
    ).toBe(true)
  })

  it('rejects an entry past the staleness boundary', () => {
    expect(
      isExplicitAgentStatusFresh(
        { updatedAt: NOW - AGENT_STATUS_STALE_AFTER_MS - 1 },
        NOW,
        AGENT_STATUS_STALE_AFTER_MS
      )
    ).toBe(false)
  })
})

describe('classifyTitleActivity', () => {
  it('classifies working, permission, idle, and unclassifiable titles', () => {
    expect(classifyTitleActivity('mimo working')).toBe('working')
    expect(classifyTitleActivity('Claude - action required')).toBe('permission')
    expect(classifyTitleActivity('✳ Claude Code ready')).toBe('idle')
    expect(classifyTitleActivity('vim')).toBe(null)
  })
})

describe('title agent identity facets', () => {
  it('splits the bare Claude spinner into activity label without committed identity', () => {
    expect(resolveTitleActivityLabel('⠋ compiling everything')).toBe('Claude Code')
    expect(resolveCommittedTitleAgentType('⠋ compiling everything')).toBe(null)
  })

  it('commits identity when the title names the agent explicitly', () => {
    expect(resolveTitleActivityLabel('✳ Claude Code working')).toBe('Claude Code')
    expect(resolveCommittedTitleAgentType('✳ Claude Code working')).toBe('claude')
  })

  it('returns neither facet for a plain shell title', () => {
    expect(resolveTitleActivityLabel('zsh')).toBe(null)
    expect(resolveCommittedTitleAgentType('zsh')).toBe(null)
  })
})

describe('resolvePaneAgentActivity', () => {
  it('reports a fresh hook row as the authoritative source and keeps the title layer visible', () => {
    const decision = resolvePaneAgentActivity({
      explicitEntry: entry({ state: 'waiting' }),
      liveTitle: '⠋ running the tests',
      hasLivePty: true,
      now: NOW
    })
    expect(decision).toEqual({
      hookState: 'waiting',
      hookAgentType: 'claude',
      titleStatus: 'working',
      source: 'hook',
      confidence: 'authoritative',
      livePtyRequired: false
    })
  })

  it('treats a stale hook row as absent and falls back to the title', () => {
    const decision = resolvePaneAgentActivity({
      explicitEntry: entry({ updatedAt: NOW - AGENT_STATUS_STALE_AFTER_MS - 1 }),
      liveTitle: '⠋ running the tests',
      hasLivePty: true,
      now: NOW
    })
    expect(decision.hookState).toBe(null)
    expect(decision.source).toBe('title')
    expect(decision.confidence).toBe('fallback')
    expect(decision.titleStatus).toBe('working')
    expect(decision.livePtyRequired).toBe(false)
  })

  it('flags title-only evidence without a live PTY so liveness-gated consumers drop it', () => {
    const decision = resolvePaneAgentActivity({
      explicitEntry: undefined,
      liveTitle: '⠋ running the tests',
      hasLivePty: false,
      now: NOW
    })
    expect(decision.source).toBe('title')
    expect(decision.livePtyRequired).toBe(true)
  })

  it('reports none when there is no fresh hook and the title carries no status', () => {
    const decision = resolvePaneAgentActivity({
      explicitEntry: undefined,
      liveTitle: 'bash',
      hasLivePty: true,
      now: NOW
    })
    expect(decision).toEqual({
      hookState: null,
      hookAgentType: undefined,
      titleStatus: null,
      source: 'none',
      confidence: 'authoritative',
      livePtyRequired: false
    })
  })

  it('passes hook state through raw, including done', () => {
    const decision = resolvePaneAgentActivity({
      explicitEntry: entry({ state: 'done' }),
      liveTitle: null,
      hasLivePty: true,
      now: NOW
    })
    expect(decision.hookState).toBe('done')
    expect(decision.source).toBe('hook')
  })
})

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
