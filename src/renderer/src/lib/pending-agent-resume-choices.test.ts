import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentResumeCandidate } from '../../../shared/agent-resume-candidate'
import {
  clearPendingAgentResumeChoices,
  getPendingAgentResumeChoices,
  resetPendingAgentResumeChoices,
  setPendingAgentResumeChoices,
  subscribePendingAgentResumeChoices
} from './pending-agent-resume-choices'

const candidate: AgentResumeCandidate = {
  agent: 'claude',
  providerSession: { key: 'session_id', id: 'a521d69e-9181-481c-ab8e-998a1881b731' },
  cwd: '/home/ubuntu/Desktop/qbit',
  title: 'Round 6',
  updatedAt: 1_789_000_000_000,
  messageCount: 758,
  branch: null,
  executionHostId: null
}

afterEach(() => {
  resetPendingAgentResumeChoices()
})

describe('pending agent resume choices', () => {
  it('holds candidates per pane and notifies that pane only', () => {
    const paneA = vi.fn()
    const paneB = vi.fn()
    subscribePendingAgentResumeChoices('pane-a', paneA)
    subscribePendingAgentResumeChoices('pane-b', paneB)

    setPendingAgentResumeChoices('pane-a', [candidate])

    expect(getPendingAgentResumeChoices('pane-a')).toEqual([candidate])
    expect(getPendingAgentResumeChoices('pane-b')).toBeUndefined()
    expect(paneA).toHaveBeenCalledTimes(1)
    expect(paneB).not.toHaveBeenCalled()
  })

  // Why: useSyncExternalStore re-renders on every notify and compares by identity, so an
  // unchanged read must keep the same reference.
  it('keeps a stable reference while unchanged', () => {
    setPendingAgentResumeChoices('pane-a', [candidate])
    expect(getPendingAgentResumeChoices('pane-a')).toBe(getPendingAgentResumeChoices('pane-a'))
  })

  it('treats an empty candidate list as nothing pending', () => {
    const listener = vi.fn()
    subscribePendingAgentResumeChoices('pane-a', listener)
    setPendingAgentResumeChoices('pane-a', [candidate])
    listener.mockClear()

    setPendingAgentResumeChoices('pane-a', [])

    expect(getPendingAgentResumeChoices('pane-a')).toBeUndefined()
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('does not notify when clearing a pane that had nothing pending', () => {
    const listener = vi.fn()
    subscribePendingAgentResumeChoices('pane-a', listener)
    clearPendingAgentResumeChoices('pane-a')
    expect(listener).not.toHaveBeenCalled()
  })

  it('stops notifying after unsubscribe', () => {
    const listener = vi.fn()
    const unsubscribe = subscribePendingAgentResumeChoices('pane-a', listener)
    unsubscribe()
    setPendingAgentResumeChoices('pane-a', [candidate])
    expect(listener).not.toHaveBeenCalled()
  })
})
