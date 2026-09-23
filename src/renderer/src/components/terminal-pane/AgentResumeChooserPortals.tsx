import type { AgentResumeCandidate } from '../../../../shared/agent-resume-candidate'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import { getAgentResumePaneHandler } from '@/lib/agent-resume-pane-handlers'
import { clearPendingAgentResumeChoices } from '@/lib/pending-agent-resume-choices'
import { usePendingAgentResumeChoices } from '@/lib/use-pending-agent-resume-choices'
import { AgentResumeChooser } from './AgentResumeChooser'

export type AgentResumeChooserPane = {
  id: number
  leafId: string
}

type AgentResumeChooserPortalsProps = {
  tabId: string
  panes: readonly AgentResumeChooserPane[]
}

/** One pane's chooser. A child component because the pending-choice subscription is a hook
 *  and the parent renders a list. The chooser portals itself through `Dialog`, so nothing is
 *  mounted into the pane's own container — a modal decision surface belongs above the app. */
function AgentResumeChooserPortal({ paneKey }: { paneKey: string }): React.JSX.Element | null {
  const choice = usePendingAgentResumeChoices(paneKey)
  if (!choice || choice.candidates.length === 0) {
    return null
  }
  const resume = (candidate: AgentResumeCandidate): void => {
    // Why the owner: the pane key is the same across a reconnect, so a choice scanned for a
    // retired binding would otherwise invoke the SUCCESSOR's handler and replace its shell.
    // Kept open when the handler refuses: another pane reserved that session between the offer
    // and the click, and the remaining rows are still the user's to choose from.
    if (getAgentResumePaneHandler(paneKey, choice.owner)?.(candidate) === true) {
      clearPendingAgentResumeChoices(paneKey)
    }
  }
  return (
    <AgentResumeChooser
      candidates={choice.candidates}
      onResume={resume}
      onDismiss={() => clearPendingAgentResumeChoices(paneKey)}
    />
  )
}

export function AgentResumeChooserPortals({
  tabId,
  panes
}: AgentResumeChooserPortalsProps): React.JSX.Element {
  return (
    <>
      {panes.map((pane) => (
        <AgentResumeChooserPortal key={pane.id} paneKey={makePaneKey(tabId, pane.leafId)} />
      ))}
    </>
  )
}
