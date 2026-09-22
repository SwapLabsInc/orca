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
}

/** One pane's chooser. A child component because the pending-choice subscription is a hook
 *  and the parent renders a list. */
function AgentResumeChooserPortal({
  paneKey,
  container
}: {
  paneKey: string
  container: HTMLElement
}): React.JSX.Element | null {
  const candidates = usePendingAgentResumeChoices(paneKey)
  if (!candidates || candidates.length === 0) {
    return null
  }
  const resume = (candidate: AgentResumeCandidate): void => {
    // Kept open when the handler refuses: another pane reserved that session between the offer
    // and the click, and the remaining rows are still the user's to choose from.
    if (getAgentResumePaneHandler(paneKey)?.(candidate) === true) {
      clearPendingAgentResumeChoices(paneKey)
    }
  }
  return createPortal(
    <AgentResumeChooser
      candidates={candidates}
      onResume={resume}
      onDismiss={() => clearPendingAgentResumeChoices(paneKey)}
    />,
    container,
    `agent-resume-chooser-${paneKey}`
  )
}

export function AgentResumeChooserPortals({
  tabId,
  panes
}: AgentResumeChooserPortalsProps): React.JSX.Element {
  return (
    <>
      {panes.map((pane) => (
        <AgentResumeChooserPortal
          key={pane.id}
          paneKey={makePaneKey(tabId, pane.leafId)}
          container={pane.container}
        />
      ))}
    </>
  )
}
