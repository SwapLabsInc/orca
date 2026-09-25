import type { AgentResumeCandidate } from '../../../shared/agent-resume-candidate'

/** The pty binding that owns a pane's resume state: an opaque key matched by identity, never read. */
export type AgentResumeOwner = WeakKey

/** What a pane can do with a chosen session. Registered by the pane's pty connection while it
 *  is bound, so the chooser can reach the live connection without threading it through React. */
export type AgentResumePaneHandler = (candidate: AgentResumeCandidate) => boolean

type RegisteredHandler = {
  /** The pty binding that registered this handler; a caller must name the same one. */
  owner: AgentResumeOwner
  handler: AgentResumePaneHandler
}

const handlersByPaneKey = new Map<string, RegisteredHandler>()

/** Returns an unregister function; a pane must call it on dispose, or a replaced connection
 *  would leave a handler pointing at a transport that no longer owns the pane.
 *
 *  The owner is nullable because it reaches here through an index-signature session bag, which let
 *  a registration that ran before the transport existed type-check and file the handler under
 *  `undefined` — where no real owner could ever match it. Admitting absence in the type is what
 *  makes that refusal reachable instead of silent. */
export function registerAgentResumePaneHandler(
  paneKey: string,
  owner: AgentResumeOwner | undefined,
  handler: AgentResumePaneHandler
): () => void {
  if (!owner) {
    console.warn('[agent-resume] refusing a pane handler with no owner:', paneKey)
    return () => {}
  }
  handlersByPaneKey.set(paneKey, { owner, handler })
  return () => {
    if (handlersByPaneKey.get(paneKey)?.handler === handler) {
      handlersByPaneKey.delete(paneKey)
    }
  }
}

/** The handler `owner` registered, or undefined. Naming the owner is what stops a chooser
 *  published for a retired binding from invoking the successor that replaced it: the pane key is
 *  the same on both sides of a reconnect, and the binding identity is not.
 *
 *  Identity, not equality: an absent owner must not match an absent registration. */
export function getAgentResumePaneHandler(
  paneKey: string,
  owner: AgentResumeOwner | undefined
): AgentResumePaneHandler | undefined {
  const registered = handlersByPaneKey.get(paneKey)
  if (!registered || !owner || registered.owner !== owner) {
    return undefined
  }
  return registered.handler
}

/** Test seam. */
export function resetAgentResumePaneHandlers(): void {
  handlersByPaneKey.clear()
}
