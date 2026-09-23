import type { AgentResumeCandidate } from '../../../shared/agent-resume-candidate'

/** What a pane can do with a chosen session. Registered by the pane's pty connection while it
 *  is bound, so the chooser can reach the live connection without threading it through React. */
export type AgentResumePaneHandler = (candidate: AgentResumeCandidate) => boolean

type RegisteredHandler = {
  /** The pty binding that registered this handler; a caller must name the same one. */
  owner: object
  handler: AgentResumePaneHandler
}

const handlersByPaneKey = new Map<string, RegisteredHandler>()

/** Returns an unregister function; a pane must call it on dispose, or a replaced connection
 *  would leave a handler pointing at a transport that no longer owns the pane. */
export function registerAgentResumePaneHandler(
  paneKey: string,
  owner: object,
  handler: AgentResumePaneHandler
): () => void {
  handlersByPaneKey.set(paneKey, { owner, handler })
  return () => {
    if (handlersByPaneKey.get(paneKey)?.handler === handler) {
      handlersByPaneKey.delete(paneKey)
    }
  }
}

/** The handler `owner` registered, or undefined. Naming the owner is what stops a chooser
 *  published for a retired binding from invoking the successor that replaced it: the pane key is
 *  the same on both sides of a reconnect, and the binding identity is not. */
export function getAgentResumePaneHandler(
  paneKey: string,
  owner: object
): AgentResumePaneHandler | undefined {
  const registered = handlersByPaneKey.get(paneKey)
  return registered?.owner === owner ? registered.handler : undefined
}

/** Test seam. */
export function resetAgentResumePaneHandlers(): void {
  handlersByPaneKey.clear()
}
