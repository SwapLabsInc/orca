import type { AgentResumeCandidate } from '../../../shared/agent-resume-candidate'

/** What a pane can do with a chosen session. Registered by the pane's pty connection while it
 *  is bound, so the chooser can reach the live connection without threading it through React. */
export type AgentResumePaneHandler = (candidate: AgentResumeCandidate) => boolean

const handlersByPaneKey = new Map<string, AgentResumePaneHandler>()

/** Returns an unregister function; a pane must call it on dispose, or a replaced connection
 *  would leave a handler pointing at a transport that no longer owns the pane. */
export function registerAgentResumePaneHandler(
  paneKey: string,
  handler: AgentResumePaneHandler
): () => void {
  handlersByPaneKey.set(paneKey, handler)
  return () => {
    if (handlersByPaneKey.get(paneKey) === handler) {
      handlersByPaneKey.delete(paneKey)
    }
  }
}

export function getAgentResumePaneHandler(paneKey: string): AgentResumePaneHandler | undefined {
  return handlersByPaneKey.get(paneKey)
}

/** Test seam. */
export function resetAgentResumePaneHandlers(): void {
  handlersByPaneKey.clear()
}
