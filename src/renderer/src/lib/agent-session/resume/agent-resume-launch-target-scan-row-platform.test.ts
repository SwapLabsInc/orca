import { describe, expect, it } from 'vitest'
import { resolveAgentResumeLaunchTarget } from './agent-resume-launch-target'

describe('resolveAgentResumeLaunchTarget with the platform a scan row reported', () => {
  it('quotes for the SSH host its own scan row named, not for Linux', () => {
    // SSH is a transport, not a platform: POSIX quoting breaks a Windows SSH host's resume argv.
    const { platform, shell } = resolveAgentResumeLaunchTarget({
      projectRuntime: undefined,
      connectionId: 'ssh-1',
      executionHostId: 'ssh:ssh-1',
      worktreePath: 'C:\\Users\\neil\\orca\\workspaces\\orca\\feature',
      terminalWindowsShell: 'cmd.exe',
      hostPlatform: 'win32'
    })

    expect({ platform, shell }).toEqual({ platform: 'win32', shell: undefined })
  })
})
