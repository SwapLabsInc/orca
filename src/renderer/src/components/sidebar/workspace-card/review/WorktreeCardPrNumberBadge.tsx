import React from 'react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { presentGitHubPRMergeState } from '@/components/github-pr-merge-state'
import { presentGitLabMRMergeState } from '@/components/right-sidebar/hosted-review/provider-actions/gitlab-mr-merge-state'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import type { WorktreeCardController } from '../controller/use-worktree-card-controller'
import { getIdentityIndicatorProps } from '../identity/worktree-card-header-items'
import {
  reviewChecksStatusLabel,
  reviewStateLabel
} from '../metadata/WorktreeCardMetadataStatusBadges'
import type { WorktreeCardPrDisplay } from './worktree-card-pr-display'
import {
  getWorktreeCardPrBadgeStatus,
  type WorktreeCardPrBadgeReason,
  type WorktreeCardPrBadgeTone
} from './worktree-card-pr-badge-tone'
import { getReviewLabel } from './worktree-review-presentation'

// Why: no merged-state token exists; callout-important carries the same purple GitHub uses for merged.
const TONE_CLASS_NAMES: Record<WorktreeCardPrBadgeTone, string> = {
  ready: 'border-status-success-border text-status-success',
  pending: 'border-status-warning-border text-status-warning-text',
  failed: 'border-destructive/30 text-destructive',
  merged: 'border-callout-important/30 text-callout-important',
  neutral: 'border-border text-muted-foreground'
}

function reasonLabel(
  review: WorktreeCardPrDisplay,
  reason: WorktreeCardPrBadgeReason,
  t: Translate
): string {
  switch (reason.kind) {
    case 'state':
      // A stateless review is a linked fallback whose title says loading or unavailable.
      return review.state ? reviewStateLabel(review.state, getReviewLabel(review), t) : review.title
    case 'conflicts':
      return t('auto.components.github.pr.merge.state.7e8bbe3cd7', 'Conflicts')
    case 'checks':
      return reviewChecksStatusLabel(reason.outcome, t)
    case 'gitHubMergeState':
      return presentGitHubPRMergeState(reason.input, t).label
    case 'gitLabMergeState':
      return presentGitLabMRMergeState(reason.review, t).label
  }
}

/** `#<number>` (`!<number>` for MRs) after the workspace title, colored by merge readiness. */
export function WorktreeCardPrNumberBadge({
  card,
  review,
  stale,
  hasHoverDetails
}: {
  card: Pick<WorktreeCardController, 'detailsHoverControl'>
  review: WorktreeCardPrDisplay
  /** The review is the last known one, so it gets no readiness color. */
  stale: boolean
  hasHoverDetails: boolean
}): React.JSX.Element | null {
  const t = useTranslate()
  const status = getWorktreeCardPrBadgeStatus(review)
  if (!status) {
    return null
  }
  const reviewLabel = getReviewLabel(review)
  const reviewNumber = `${reviewLabel === 'MR' ? '!' : '#'}${review.number}`
  const reason = reasonLabel(review, status.reason, t)
  const label = stale
    ? `${reviewLabel} ${reviewNumber} · ${reason} · ${t('workspace.links.lastKnownStatus', 'Last known status')}`
    : `${reviewLabel} ${reviewNumber} · ${reason}`
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          role="img"
          aria-label={label}
          tabIndex={0}
          {...getIdentityIndicatorProps({ card, hasHoverDetails })}
          className={cn(
            'inline-flex h-4 shrink-0 items-center rounded border px-1 text-3xs font-medium leading-none whitespace-nowrap tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-ring',
            TONE_CLASS_NAMES[stale ? 'neutral' : status.tone]
          )}
        >
          {reviewNumber}
        </span>
      </TooltipTrigger>
      <TooltipContent
        side="right"
        sideOffset={8}
        className={cn(hasHoverDetails && card.detailsHoverControl.hoverOpen && 'hidden')}
      >
        {label}
      </TooltipContent>
    </Tooltip>
  )
}
