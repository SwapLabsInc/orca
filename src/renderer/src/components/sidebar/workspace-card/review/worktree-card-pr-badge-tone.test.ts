import { describe, expect, it } from 'vitest'

import { getWorktreeCardPrBadgeStatus } from './worktree-card-pr-badge-tone'
import type { WorktreeCardPrDisplay } from './worktree-card-pr-display'
import { referenceReview } from './workspace-reference-fixtures.test-support'

function tone(review: WorktreeCardPrDisplay) {
  return getWorktreeCardPrBadgeStatus(review)?.tone ?? null
}

describe('getWorktreeCardPrBadgeStatus', () => {
  it('ranks CI and requested changes over review gates and never reports unknown data as ready', () => {
    const approved = { mergeStateStatus: 'CLEAN', reviewDecision: 'APPROVED' } as const
    expect(tone(referenceReview(42, approved))).toBe('ready')
    expect(tone(referenceReview(42, { ...approved, mergeQueueRequired: true }))).toBe('ready')
    expect(
      tone(
        referenceReview(42, {
          status: 'failure',
          reviewDecision: 'REVIEW_REQUIRED',
          mergeStateStatus: 'BLOCKED'
        })
      )
    ).toBe('failed')
    expect(
      tone(
        referenceReview(42, {
          status: 'pending',
          reviewDecision: 'CHANGES_REQUESTED',
          mergeStateStatus: 'BLOCKED'
        })
      )
    ).toBe('failed')
    expect(tone(referenceReview(42, { status: 'pending', mergeStateStatus: 'BLOCKED' }))).toBe(
      'pending'
    )
    expect(
      tone(
        referenceReview(42, {
          ...approved,
          status: 'failure',
          checksSummary: {
            state: 'failure',
            total: 2,
            passed: 1,
            failed: 1,
            cancelled: 1,
            pending: 0,
            neutral: 0
          }
        })
      )
    ).toBe('neutral')
    expect(tone(referenceReview(42, { state: 'merged' }))).toBe('merged')
    expect(tone(referenceReview(42, { state: 'closed' }))).toBeNull()
    expect(tone({ provider: 'github', number: 42, title: 'Loading PR...' })).toBe('neutral')
    expect(
      tone({ provider: 'github', number: 42, title: 'PR', state: 'open', status: 'success' })
    ).toBe('neutral')
    expect(
      tone(
        referenceReview(42, {
          provider: 'gitlab',
          mergeable: 'UNKNOWN',
          mergeStateStatus: 'requested_changes'
        })
      )
    ).toBe('failed')
    expect(
      tone(
        referenceReview(42, {
          provider: 'gitlab',
          mergeable: 'UNKNOWN',
          mergeStateStatus: 'external_status_checks'
        })
      )
    ).toBe('failed')
    expect(tone(referenceReview(42, { provider: 'bitbucket' }))).toBe('neutral')
  })
})
