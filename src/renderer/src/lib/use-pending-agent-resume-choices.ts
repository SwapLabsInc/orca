import { useCallback, useSyncExternalStore } from 'react'
import type { AgentResumeCandidate } from '../../../shared/agent-resume-candidate'
import {
  getPendingAgentResumeChoices,
  subscribePendingAgentResumeChoices
} from './pending-agent-resume-choices'

/** The chooser candidates pending for one pane, or undefined when it has none. */
export function usePendingAgentResumeChoices(
  paneKey: string
): readonly AgentResumeCandidate[] | undefined {
  const subscribe = useCallback(
    (listener: () => void) => subscribePendingAgentResumeChoices(paneKey, listener),
    [paneKey]
  )
  const read = useCallback(() => getPendingAgentResumeChoices(paneKey), [paneKey])
  // Why getServerSnapshot === read: the store holds no pending choice during SSR/test hydration,
  // and both reads answer undefined, so one function is correct for both.
  return useSyncExternalStore(subscribe, read, read)
}
