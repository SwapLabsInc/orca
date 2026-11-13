import { getDefaultSettings } from '../../../../../../shared/constants'
import type { HostedReviewInfo } from '../../../../../../shared/source-control/hosted-review/hosted-review-contracts'
import type { WorktreeCardProperty } from '../../../../../../shared/ui-chrome-types'
import type { Worktree } from '../../../../../../shared/worktree/types'
import { getHostedReviewCacheKey } from '@/store/slices/hosted-review/hosted-review-cache-identity'
import { defineFixture } from '../../../../component-fixtures/component-fixture'
import { makeRepo, makeWorktree } from '../../../worktree-jump/worktree-jump-palette-test-fixtures'
import WorktreeCard from '../surface/WorktreeCard'
import { referenceReview } from './workspace-reference-fixtures.test-support'

const repo = { ...makeRepo(), displayName: 'orca' }

/** An open, approved, clean PR with green checks, varied per case. */
function pr(number: number, overrides: Partial<HostedReviewInfo> = {}): HostedReviewInfo {
  return referenceReview(number, {
    mergeStateStatus: 'CLEAN',
    reviewDecision: 'APPROVED',
    ...overrides
  })
}

const gitLabMR = referenceReview(42, {
  provider: 'gitlab',
  url: 'https://gitlab.com/acme/orca/-/merge_requests/42',
  mergeable: 'UNKNOWN',
  mergeStateStatus: 'requested_changes'
})

const bitbucketPR = referenceReview(310, {
  provider: 'bitbucket',
  url: 'https://bitbucket.org/acme/orca/pull-requests/310',
  mergeable: 'UNKNOWN'
})

/** Each card links the review the badge reads from its own cache entry; null leaves it loading. */
type BadgeCase = {
  id: string
  name: string
  review: HostedReviewInfo | null
  link: Partial<Worktree>
}

const cases: BadgeCase[] = [
  { id: 'pr-ready', name: 'Ready to merge', review: pr(1204), link: { linkedPR: 1204 } },
  {
    id: 'pr-review',
    name: 'Waiting for approval',
    review: pr(1188, { reviewDecision: 'REVIEW_REQUIRED', mergeStateStatus: 'BLOCKED' }),
    link: { linkedPR: 1188 }
  },
  {
    id: 'pr-checks-pending',
    name: 'Checks running',
    review: pr(1176, { status: 'pending', mergeStateStatus: 'BLOCKED' }),
    link: { linkedPR: 1176 }
  },
  {
    id: 'pr-checks-failed',
    name: 'CI failed, approval required',
    review: pr(1153, {
      status: 'failure',
      reviewDecision: 'REVIEW_REQUIRED',
      mergeStateStatus: 'BLOCKED'
    }),
    link: { linkedPR: 1153 }
  },
  {
    id: 'pr-changes-pending',
    name: 'Changes requested, CI running',
    review: pr(1162, {
      status: 'pending',
      reviewDecision: 'CHANGES_REQUESTED',
      mergeStateStatus: 'BLOCKED'
    }),
    link: { linkedPR: 1162 }
  },
  {
    id: 'pr-cancelled',
    name: 'CI cancelled',
    review: pr(1158, {
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
    }),
    link: { linkedPR: 1158 }
  },
  {
    id: 'pr-merge-queue',
    name: 'Ready, merges through the queue',
    review: pr(1196, { mergeQueueRequired: true }),
    link: { linkedPR: 1196 }
  },
  {
    id: 'pr-conflicts',
    name: 'Merge conflicts',
    review: pr(1140, { mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' }),
    link: { linkedPR: 1140 }
  },
  {
    id: 'mr-changes',
    name: 'GitLab MR, changes requested',
    review: gitLabMR,
    link: { linkedGitLabMR: 42 }
  },
  {
    id: 'mr-external-checks',
    name: 'GitLab MR, external checks blocking',
    review: referenceReview(43, {
      provider: 'gitlab',
      url: 'https://gitlab.com/acme/orca/-/merge_requests/43',
      mergeable: 'UNKNOWN',
      mergeStateStatus: 'external_status_checks'
    }),
    link: { linkedGitLabMR: 43 }
  },
  {
    id: 'bitbucket-pr',
    name: 'Bitbucket PR, no merge verdict',
    review: bitbucketPR,
    link: { linkedBitbucketPR: 310 }
  },
  {
    id: 'pr-merged',
    name: 'Merged',
    review: pr(1102, { state: 'merged' }),
    link: { linkedPR: 1102 }
  },
  {
    id: 'pr-draft',
    name: 'Draft',
    review: pr(1210, { state: 'draft' }),
    link: { linkedPR: 1210 }
  },
  { id: 'pr-loading', name: 'Linked PR still loading', review: null, link: { linkedPR: 1215 } },
  {
    id: 'pr-closed',
    name: 'Closed without merging, no badge',
    review: pr(1099, { state: 'closed' }),
    link: { linkedPR: 1099 }
  },
  {
    id: 'pr-long-title',
    name: 'A long workspace title truncates before the PR number badge does',
    review: pr(12345),
    link: { linkedPR: 12345 }
  }
]

function cardsFixture(
  style: { newCardStyle: boolean; compact?: boolean },
  properties: WorktreeCardProperty[],
  shown = cases,
  interact?: (frame: HTMLElement) => Promise<void>
) {
  const settings = {
    ...getDefaultSettings('/home/fixture'),
    experimentalNewWorktreeCardStyle: style.newCardStyle,
    compactWorktreeCards: style.compact === true
  }
  const worktrees = shown.map((entry) =>
    makeWorktree(entry.id, entry.name, { branch: `refs/heads/${entry.id}`, ...entry.link })
  )
  const hostedReviewCache = Object.fromEntries(
    shown.flatMap((entry) =>
      entry.review
        ? [
            [
              getHostedReviewCacheKey(
                repo.path,
                entry.id,
                settings,
                repo.id,
                repo.connectionId,
                repo.executionHostId,
                true
              ),
              { data: entry.review, fetchedAt: Date.now() }
            ]
          ]
        : []
    )
  )
  return defineFixture({
    width: 320,
    store: {
      settings,
      repos: [repo],
      worktreesByRepo: { [repo.id]: worktrees },
      worktreeCardProperties: properties,
      hostedReviewCache
    },
    render: () => (
      <div className="flex flex-col gap-1 bg-worktree-sidebar p-2 text-worktree-sidebar-foreground">
        {worktrees.map((worktree) => (
          <WorktreeCard
            key={worktree.id}
            worktree={worktree}
            repo={repo}
            isActive={false}
            nativeDragEnabled={false}
          />
        ))}
      </div>
    ),
    interact
  })
}

function tooltipFixture(caseId: string, expected: string) {
  return cardsFixture(
    { newCardStyle: true },
    ['status', 'branch'],
    cases.filter((entry) => entry.id === caseId),
    async (frame) => {
      frame.querySelector<HTMLElement>('[data-worktree-card-identity-indicator]')?.focus()
      await new Promise((resolve) => setTimeout(resolve, 400))
      const tooltip = document.querySelector('[data-slot="tooltip-content"]')?.textContent
      if (!tooltip?.includes(expected)) {
        throw new Error(`Focusing the badge should open a tooltip naming ${expected}`)
      }
    }
  )
}

/** The badge in each merge-readiness tone on new-style cards (Status shown). */
export const newStyle = cardsFixture({ newCardStyle: true }, ['status', 'branch'])

/** Classic cards show the badge when the PR property is on. */
export const classic = cardsFixture({ newCardStyle: false }, ['status', 'branch', 'pr'])

export const compact = cardsFixture({ newCardStyle: false, compact: true }, [
  'status',
  'branch',
  'pr'
])

/** Failing CI outranks the approval gate, and the tooltip names the failing checks. */
export const failingTooltip = tooltipFixture('pr-checks-failed', 'PR #1153')

/** GitLab numbers MRs with `!`, and requested changes read as failed. */
export const gitLabTooltip = tooltipFixture('mr-changes', 'MR !42')
