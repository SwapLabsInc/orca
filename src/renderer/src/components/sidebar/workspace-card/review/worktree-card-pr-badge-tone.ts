import { getProviderChecksOutcome } from '../../../../../../shared/source-control/checks/provider-check-summary'
import {
  resolveGitHubPRMergeState,
  type GitHubPRMergeStateInput,
  type GitHubPRMergeStateKind
} from '../../../../../../shared/github/pull-request-merge-state'
import type { HostedReviewInfo } from '../../../../../../shared/source-control/hosted-review/hosted-review-contracts'
import { hostedReviewMergeStateInput } from '@/components/github-pr-merge-state'
import { getGitLabMergeBlocker } from '@/components/right-sidebar/hosted-review/provider-actions/gitlab-mr-merge-state'
import type { WorktreeCardPrDisplay } from './worktree-card-pr-display'

export type WorktreeCardPrBadgeTone = 'ready' | 'pending' | 'failed' | 'merged' | 'neutral'

/** The fact that set the tone, so the badge's label names the same reason. */
export type WorktreeCardPrBadgeReason =
  | { kind: 'state' }
  | { kind: 'conflicts' }
  | { kind: 'checks'; outcome: 'failure' | 'cancelled' | 'pending' | 'success' }
  | { kind: 'gitHubMergeState'; input: GitHubPRMergeStateInput }
  | { kind: 'gitLabMergeState'; review: HostedReviewInfo }

export type WorktreeCardPrBadgeStatus = {
  tone: WorktreeCardPrBadgeTone
  reason: WorktreeCardPrBadgeReason
}

const READY_MERGE_KINDS: ReadonlySet<GitHubPRMergeStateKind> = new Set([
  'mergeable_checks_passed',
  'mergeable',
  'checks_passed'
])

function requestedChangesReason(review: HostedReviewInfo): WorktreeCardPrBadgeReason | null {
  if (review.provider === 'github') {
    return review.reviewDecision === 'CHANGES_REQUESTED'
      ? { kind: 'gitHubMergeState', input: hostedReviewMergeStateInput(review) }
      : null
  }
  return review.provider === 'gitlab' &&
    getGitLabMergeBlocker(review.mergeStateStatus) === 'changes_requested'
    ? { kind: 'gitLabMergeState', review }
    : null
}

function gitHubMergeStateStatus(review: HostedReviewInfo): WorktreeCardPrBadgeStatus {
  const input = hostedReviewMergeStateInput(review)
  // Why: a merge queue changes how a ready PR merges, not whether it is ready.
  const queueless = { ...input, mergeQueueRequired: false }
  const { kind } = resolveGitHubPRMergeState(queueless)
  if (READY_MERGE_KINDS.has(kind)) {
    return { tone: 'ready', reason: { kind: 'gitHubMergeState', input } }
  }
  return {
    tone: kind === 'blocked' ? 'failed' : 'pending',
    reason: { kind: 'gitHubMergeState', input: queueless }
  }
}

// Other providers' mappers carry no review, approval or branch-policy state, so MERGEABLE is never green.
function mergeStateStatus(review: HostedReviewInfo): WorktreeCardPrBadgeStatus | null {
  if (review.mergeable === undefined && review.mergeStateStatus === undefined) {
    return null
  }
  if (review.provider === 'github') {
    return gitHubMergeStateStatus(review)
  }
  if (review.provider !== 'gitlab') {
    return null
  }
  const reason: WorktreeCardPrBadgeReason = { kind: 'gitLabMergeState', review }
  // Same rule as presentGitLabMRMergeState: only an explicit MERGEABLE verdict merges directly.
  if (review.mergeable === 'MERGEABLE') {
    return { tone: 'ready', reason }
  }
  const blocked = getGitLabMergeBlocker(review.mergeStateStatus) === 'blocked'
  return { tone: blocked ? 'failed' : 'pending', reason }
}

/** Merge readiness for the title-row PR badge; null hides it (closed without merging). */
export function getWorktreeCardPrBadgeStatus(
  review: WorktreeCardPrDisplay
): WorktreeCardPrBadgeStatus | null {
  if (review.state === 'closed') {
    return null
  }
  if (review.state === 'merged') {
    return { tone: 'merged', reason: { kind: 'state' } }
  }
  // A draft or a review whose details have not loaded makes no readiness claim.
  if (review.state !== 'open') {
    return { tone: 'neutral', reason: { kind: 'state' } }
  }
  const merge = 'mergeable' in review ? review : null
  if (merge?.mergeable === 'CONFLICTING' || merge?.mergeStateStatus === 'DIRTY') {
    return { tone: 'failed', reason: { kind: 'conflicts' } }
  }
  const checks = review.status
    ? getProviderChecksOutcome(review.checksSummary, review.status)
    : undefined
  // Why: Source Control ranks a required review first; red CI must still read as failed.
  if (checks === 'failure') {
    return { tone: 'failed', reason: { kind: 'checks', outcome: checks } }
  }
  // Requested changes stay red whatever CI does, so the badge never turns red only once CI passes.
  const requestedChanges = merge ? requestedChangesReason(merge) : null
  if (requestedChanges) {
    return { tone: 'failed', reason: requestedChanges }
  }
  if (checks === 'pending') {
    return { tone: 'pending', reason: { kind: 'checks', outcome: checks } }
  }
  // Cancelled CI proves nothing either way, matching Source Control's muted "Cancelled".
  if (checks === 'cancelled') {
    return { tone: 'neutral', reason: { kind: 'checks', outcome: checks } }
  }
  const verdict = merge ? mergeStateStatus(merge) : null
  if (verdict) {
    return verdict
  }
  // Passing checks alone never prove a PR is ready to merge.
  return {
    tone: 'neutral',
    reason: checks === 'success' ? { kind: 'checks', outcome: checks } : { kind: 'state' }
  }
}
