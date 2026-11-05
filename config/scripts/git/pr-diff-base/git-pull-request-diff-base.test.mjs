import { describe, expect, it } from 'vitest'
import { selectPullRequestDiffBase } from './git-pull-request-diff-base.mjs'

describe('pull request diff base selection', () => {
  it('uses the merge commit first parent for pull request checkouts', () => {
    expect(
      selectPullRequestDiffBase('event-base', ['current-base', 'pull-request-head'], 'pull_request')
    ).toBe('current-base')
  })

  it('keeps the requested base outside synthetic pull request merges', () => {
    expect(selectPullRequestDiffBase('requested-base', ['parent'], 'pull_request')).toBe(
      'requested-base'
    )
    expect(selectPullRequestDiffBase('requested-base', ['parent', 'other'], 'push')).toBe(
      'requested-base'
    )
  })

  // LOCAL: set only for the fork's own upstream sync PRs.
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
