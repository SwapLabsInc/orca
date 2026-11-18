import type { WorktreeCardPrDisplay } from './worktree-card-pr-display'
import { getReviewLabel } from './worktree-review-presentation'

/** `#<number>`, or `!<number>` for a GitLab MR. */
export function getReviewNumber(review: WorktreeCardPrDisplay): string {
  return `${getReviewLabel(review) === 'MR' ? '!' : '#'}${review.number}`
}

/** `PR #<number>` or `MR !<number>`. */
export function getNumberedReviewLabel(review: WorktreeCardPrDisplay): string {
  return `${getReviewLabel(review)} ${getReviewNumber(review)}`
}
