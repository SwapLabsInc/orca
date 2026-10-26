import type {
  AgentHookRelayEnvelope,
  AgentHookRelayUserEndedSessionEnvelope,
  AgentHookUnavailableEnvelope
} from '../shared/agent-hook-relay'
import type { TmuxManagedPty } from '../shared/tmux-agent-hook-owner'

export type RelayHookForward = (envelope: AgentHookRelayEnvelope) => void

export type RelayHookServerOptions = {
  /** Where to put endpoint.env / endpoint.cmd. Defaults to `$HOME/.orca-relay/agent-hooks`. */
  endpointDir?: string
  // Default remote tag avoids main’s dev/prod mismatch warnings.
  env?: string
  // WSL passes the host token via WSLENV for unmodified hook clients; otherwise generate a UUID.
  token?: string
  // Prefer the Windows listener’s port for env-discovered WSL hooks; fall back to ephemeral if occupied.
  preferredPort?: number
  forwardUnavailable?: (envelope: AgentHookUnavailableEnvelope) => void
  forward: RelayHookForward
  /** Where a user-ended Claude session goes; set only where the host may resume this relay's panes. */
  forwardUserEndedSession?: (envelope: AgentHookRelayUserEndedSessionEnvelope) => void
  forwardClaudeAgentView?: (body: unknown) => Promise<unknown>
  // Retired pane posts own no client surface; absent this callback, forward everything for legacy listeners without PTY state.
  getTmuxManagedPty?: (paneKey: string) => Promise<TmuxManagedPty | null>
  /** Token captured from the successful host spawn; absent authority keeps the physical poster. */
  getAgentLaunchToken?: (paneKey: string) => string | undefined
  isPaneSurfaceRetired?: (paneKey: string) => boolean
}

export type RelayHookServerStartOptions = {
  publishEndpoint?: boolean
}
