import { useCallback, useSyncExternalStore } from 'react'
import {
  getPendingAgentResumeChoices,
  subscribePendingAgentResumeChoices,
  type PendingAgentResumeChoice
} from './pending-agent-resume-choices'

/** The choice pending for one pane — its candidates and the binding that scanned them — or
 *  undefined when it has none. */
export function usePendingAgentResumeChoices(
  paneKey: string
): PendingAgentResumeChoice | undefined {
  const subscribe = useCallback(
    (listener: () => void) => subscribePendingAgentResumeChoices(paneKey, listener),
    [paneKey]
  )
  const read = useCallback(() => getPendingAgentResumeChoices(paneKey), [paneKey])
  // Why getServerSnapshot === read: the store holds no pending choice during SSR/test hydration,
  // and both reads answer undefined, so one function is correct for both.
  return useSyncExternalStore(subscribe, read, read)
}
