import { createPortal } from 'react-dom'
import type { AgentResumeCandidate } from '../../../../shared/agent-resume-candidate'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import { getAgentResumePaneHandler } from '@/lib/agent-resume-pane-handlers'
import { clearPendingAgentResumeChoices } from '@/lib/pending-agent-resume-choices'
import { usePendingAgentResumeChoices } from '@/lib/use-pending-agent-resume-choices'
import { AgentResumeChooser } from './AgentResumeChooser'

export type AgentResumeChooserPane = {
  id: number
  leafId: string
  container: HTMLElement
}

type AgentResumeChooserPortalsProps = {
  tabId: string
  panes: readonly AgentResumeChooserPane[]
  /** Passed in so the relative ages in the list are computed once per render, not per row. */
  now: number
}

/** One pane's chooser. A child component because the pending-choice subscription is a hook
 *  and the parent renders a list. */
function AgentResumeChooserPortal({
  paneKey,
  container,
  now
}: {
  paneKey: string
  container: HTMLElement
  now: number
}): React.JSX.Element | null {
  const candidates = usePendingAgentResumeChoices(paneKey)
  if (!candidates || candidates.length === 0) {
    return null
  }
  const resume = (candidate: AgentResumeCandidate): void => {
    // Clear first: the respawn replaces this pane's connection, and a chooser still mounted
    // over it would offer a session that is now being resumed.
    clearPendingAgentResumeChoices(paneKey)
    getAgentResumePaneHandler(paneKey)?.(candidate)
  }
  return createPortal(
    <AgentResumeChooser
      candidates={candidates}
      onResume={resume}
      onDismiss={() => clearPendingAgentResumeChoices(paneKey)}
      now={now}
    />,
    container,
    `agent-resume-chooser-${paneKey}`
  )
}

export function AgentResumeChooserPortals({
  tabId,
  panes,
  now
}: AgentResumeChooserPortalsProps): React.JSX.Element {
  return (
    <>
      {panes.map((pane) => (
        <AgentResumeChooserPortal
          key={pane.id}
          paneKey={makePaneKey(tabId, pane.leafId)}
          container={pane.container}
          now={now}
        />
      ))}
    </>
  )
}
