import { describe, expect, it } from 'vitest'
import { selectPullRequestDiffBase } from './git-pull-request-diff-base.mjs'

// LOCAL: set only for the fork's own upstream sync PRs.
describe('upstream sync pull request diff base', () => {
  it('prefers the sync base over the merge commit first parent', () => {
    expect(
      selectPullRequestDiffBase(
        'event-base',
        ['current-base', 'sync-head'],
        'pull_request',
        'upstream-tip'
      )
    ).toBe('upstream-tip')
    expect(
      selectPullRequestDiffBase('event-base', ['current-base', 'sync-head'], 'pull_request', '')
    ).toBe('current-base')
  })
})
