import { describe, expect, it } from 'vitest'
import { shouldShowTabGroupEmptyState } from './tab-group-empty-state-visibility'

const ready = { workspaceSessionReady: true, worktreeId: 'wt', groupTabCount: 0 }

describe('shouldShowTabGroupEmptyState', () => {
  it('shows for a workspace whose accepted inventory is explicitly empty', () => {
    expect(shouldShowTabGroupEmptyState({ ...ready, tabsByWorktree: { wt: [] } })).toBe(true)
  })

  it('waits while the workspace inventory has not arrived', () => {
    expect(shouldShowTabGroupEmptyState({ ...ready, tabsByWorktree: {} })).toBe(false)
  })

  it('stays hidden while the mirrored inventory still lists terminals', () => {
    expect(shouldShowTabGroupEmptyState({ ...ready, tabsByWorktree: { wt: [{}] } })).toBe(false)
  })

  it('stays hidden before the session hydrates or when the group has tabs', () => {
    const emptyRow = { tabsByWorktree: { wt: [] } }
    expect(
      shouldShowTabGroupEmptyState({ ...ready, ...emptyRow, workspaceSessionReady: false })
    ).toBe(false)
    expect(shouldShowTabGroupEmptyState({ ...ready, ...emptyRow, groupTabCount: 1 })).toBe(false)
  })
})
