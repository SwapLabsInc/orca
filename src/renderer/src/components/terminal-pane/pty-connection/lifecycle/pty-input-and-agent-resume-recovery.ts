import { installPtyInputRecovery } from './pty-input-recovery'
import { installAgentResumeRecovery } from '../startup/agent-resume-recovery-install'
import type { ConnectPanePtySession } from '../connect-pane-pty-session'

/** SwapLabs: upstream's input recovery, then the agent resume recovery. That one registers the
 *  chooser's pane handler under the `session.transport` installPaneTransport assigned before both. */
export function installPtyInputAndAgentResumeRecovery(session: ConnectPanePtySession): void {
  installPtyInputRecovery(session)
  installAgentResumeRecovery(session)
}
