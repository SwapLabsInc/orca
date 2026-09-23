import { createBrowserUuid } from '@/lib/browser-uuid'
import { buildAgentResumeStartupPlan } from '@/lib/tui-agent-startup'
import type { AgentResumeCandidate } from '../../../../../shared/agent-resume-candidate'
import {
  resolveTuiAgentLaunchArgs,
  resolveTuiAgentLaunchEnv
} from '../../../../../shared/tui-agent-launch-defaults'
import type { TuiAgent } from '../../../../../shared/tui-agent'
import type { AgentStartupShell } from '../../../../../shared/tui-agent-startup-shell'

import type { ColdRestoreAgentResumeStartup } from './fresh-spawn-types'

/**
 * Turns a session recovered from the host's index into a spawn payload.
 *
 * Unlike the cold-restore path there is no captured `launchConfig` to reuse — the handle that
 * held it is exactly what was lost — so the pane's configured defaults for that agent apply.
 * A resumed pane therefore comes back with default flags rather than the flags the original
 * turn ran with; the resume itself is what matters, and inventing the old flags would be a
 * guess about a launch nobody recorded.
 */
export function buildCandidateResumeStartup(args: {
  candidate: AgentResumeCandidate
  cmdOverrides: Partial<Record<TuiAgent, string>>
  agentDefaultArgs: Partial<Record<TuiAgent, string>> | undefined
  agentDefaultEnv: Partial<Record<TuiAgent, Record<string, string>>> | undefined
  platform: NodeJS.Platform
  /** Optional exactly as the plan builder takes it: absent means the host default. */
  shell?: AgentStartupShell
}): ColdRestoreAgentResumeStartup | null {
  const { candidate } = args
  const startupPlan = buildAgentResumeStartupPlan({
    agent: candidate.agent,
    providerSession: candidate.providerSession,
    cmdOverrides: args.cmdOverrides,
    agentArgs: resolveTuiAgentLaunchArgs(candidate.agent, args.agentDefaultArgs),
    agentEnv: resolveTuiAgentLaunchEnv(candidate.agent, args.agentDefaultEnv),
    platform: args.platform,
    ...(args.shell ? { shell: args.shell } : {})
  })
  if (!startupPlan) {
    return null
  }
  const launchToken = createBrowserUuid()
  return {
    agent: candidate.agent,
    command: startupPlan.launchCommand,
    env: { ...startupPlan.env, ORCA_AGENT_LAUNCH_TOKEN: launchToken },
    launchConfig: startupPlan.launchConfig,
    resumeProviderSession: candidate.providerSession,
    launchToken,
    // Neither is true here: this pane had no live entry and no record — that is why the
    // recovery path ran at all. Saying otherwise would make the spawn consume a record
    // that does not exist.
    useLiveEntry: false,
    hasSleepingRecord: false,
    sleepingRecordEntry: null
  }
}
