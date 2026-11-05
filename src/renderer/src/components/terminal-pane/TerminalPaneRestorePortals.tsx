import { AgentResumeChooserPortals } from './AgentResumeChooserPortals'
import { SessionRestoredBannerPortals } from './SessionRestoredBannerPortals'
import type { TerminalPaneController } from './use-terminal-pane-controller'

/** SwapLabs: the fork's resume chooser beside upstream's restored-session banner. */
export function TerminalPaneRestorePortals({
  controller
}: {
  controller: TerminalPaneController
}): React.JSX.Element {
  const { isActive, managerRef, sessionRestoredBannerPaneIds, tabId } = controller
  const panes = managerRef.current?.getPanes() ?? []
  return (
    <>
      <SessionRestoredBannerPortals panes={panes} paneIds={sessionRestoredBannerPaneIds} />
      {/* Only the active tab: the chooser is an app-modal Dialog now, and an inactive tab's
          pending choice would otherwise follow the user onto whatever tab they switched to. */}
      {isActive && <AgentResumeChooserPortals tabId={tabId} panes={panes} />}
    </>
  )
}
