/**
 * Both directions of THE PANE-IDENTITY CLAIM RULE, which replaced `entry.state !== 'done'`:
 *
 *  - too BROAD: after a host restart the recovering pane's own persisted row comes back as
 *    `restoredUnconfirmed` with its provider session, and counting it made the pane filter out the
 *    one candidate it was trying to recover;
 *  - too NARROW: `done` means "task complete but pane live", so excluding those rows let a live
 *    idle sibling's transcript be resumed into a second pane.
 */
import { describe, expect, it } from 'vitest'
import type { AgentStatusEntry } from '../../../shared/agent-status-types'
import {
  agentResumeSessionsClaimedByOtherPanes,
  resolveAgentResumePaneLiveness,
  type AgentResumeClaimState
} from './agent-resume-session-claims'

const PANE = 'tab-1:1a1c4f4a-3c0f-4a31-9c1e-1d6f1a0b2c30'
const SIBLING = 'tab-2:2b2c4f4a-3c0f-4a31-9c1e-1d6f1a0b2c31'
const PANE_LEAF = '1a1c4f4a-3c0f-4a31-9c1e-1d6f1a0b2c30'
const SIBLING_LEAF = '2b2c4f4a-3c0f-4a31-9c1e-1d6f1a0b2c31'

function row(id: string, state: AgentStatusEntry['state'], extra: Partial<AgentStatusEntry> = {}) {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the rule reads only `providerSession` and the pane key; every other AgentStatusEntry field is untouched by it.
  return {
    state,
    providerSession: { key: 'session_id', id },
    ...extra
  } as AgentStatusEntry
}

function stateWith(
  agentStatusByPaneKey: Record<string, AgentStatusEntry>,
  ptyIdsByLeafId: Record<string, Record<string, string | undefined>>
): AgentResumeClaimState {
  return {
    agentStatusByPaneKey,
    terminalLayoutsByTabId: Object.fromEntries(
      Object.entries(ptyIdsByLeafId).map(([tabId, bindings]) => [
        tabId,
        { ptyIdsByLeafId: bindings }
      ])
    )
  }
}

describe('pane liveness', () => {
  it('reads a bound leaf as live, an unbound leaf of a held tab as unverifiable, a gone tab as exited', () => {
    const state = stateWith(
      {},
      { 'tab-1': { [PANE_LEAF]: 'pty-1' }, 'tab-2': { [SIBLING_LEAF]: undefined } }
    )

    expect(resolveAgentResumePaneLiveness(state, PANE)).toBe('live')
    expect(resolveAgentResumePaneLiveness(state, SIBLING)).toBe('unverifiable')
    expect(
      resolveAgentResumePaneLiveness(state, 'tab-gone:3c3c4f4a-3c0f-4a31-9c1e-1d6f1a0b2c32')
    ).toBe('exited')
  })
})

describe('the pane-identity claim rule', () => {
  // TOO BROAD, fixed: the restart scenario. The pane's own `working` row is republished as
  // `restoredUnconfirmed` and must not claim the session the pane is trying to get back.
  it("never treats the recovering pane's own republished row as a claim against it", () => {
    const state = stateWith(
      { [PANE]: row('session-own', 'working', { restoredUnconfirmed: true }) },
      { 'tab-1': { [PANE_LEAF]: 'pty-1' } }
    )

    expect(agentResumeSessionsClaimedByOtherPanes(state, PANE)).toEqual(new Set())
  })

  it("does not claim the pane's own row for any state, including done", () => {
    for (const state of ['working', 'blocked', 'waiting', 'done'] as const) {
      const claims = agentResumeSessionsClaimedByOtherPanes(
        stateWith({ [PANE]: row('session-own', state) }, { 'tab-1': { [PANE_LEAF]: 'pty-1' } }),
        PANE
      )
      expect(claims).toEqual(new Set())
    }
  })

  // TOO NARROW, fixed: `done` is "task complete but pane live", so a live idle sibling still owns
  // its transcript. Resuming it here would put two agents on one conversation.
  it('claims a done-but-live sibling', () => {
    const state = stateWith(
      { [SIBLING]: row('session-sibling', 'done') },
      { 'tab-1': { [PANE_LEAF]: 'pty-1' }, 'tab-2': { [SIBLING_LEAF]: 'pty-2' } }
    )

    expect(agentResumeSessionsClaimedByOtherPanes(state, PANE)).toEqual(
      new Set(['session-sibling'])
    )
  })

  it('claims a sibling whose liveness is only unverifiable, because contact loss is not death', () => {
    const state = stateWith(
      { [SIBLING]: row('session-sibling', 'done', { restoredUnconfirmed: true }) },
      { 'tab-1': { [PANE_LEAF]: 'pty-1' }, 'tab-2': {} }
    )

    expect(agentResumeSessionsClaimedByOtherPanes(state, PANE)).toEqual(
      new Set(['session-sibling'])
    )
  })

  it('releases a session whose pane this renderer no longer holds', () => {
    const state = stateWith(
      { [SIBLING]: row('session-sibling', 'working') },
      { 'tab-1': { [PANE_LEAF]: 'pty-1' } }
    )

    expect(agentResumeSessionsClaimedByOtherPanes(state, PANE)).toEqual(new Set())
  })

  it('ignores a row that carries no provider session', () => {
    const state = stateWith(
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a row with no providerSession is the shape the rule must skip; no other field is read.
      { [SIBLING]: { state: 'working' } as AgentStatusEntry },
      { 'tab-2': { [SIBLING_LEAF]: 'pty-2' } }
    )

    expect(agentResumeSessionsClaimedByOtherPanes(state, PANE)).toEqual(new Set())
  })
})
