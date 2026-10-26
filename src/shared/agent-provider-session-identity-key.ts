import type { AgentProviderSessionMetadata } from './agent-session-resume'

/** One provider session's identity as a string key, matching `agentProviderSessionsEqual`. */
export function agentProviderSessionIdentityKey(
  agent: string,
  session: AgentProviderSessionMetadata
): string {
  const base = `${agent}\0${session.key}\0${session.id}`
  return agent === 'pi' || agent === 'prime-agent'
    ? `${base}\0${session.transcriptPath ?? ''}`
    : base
}
