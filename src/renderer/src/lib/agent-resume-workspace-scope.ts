/**
 * The directory a pane's agent sessions would have run in.
 *
 * Read from EITHER workspace representation: a folder workspace is not a git worktree and keeps
 * its root on `folderWorkspace.folderPath`, so gating recovery on `worktree.path` alone made
 * every agent pane in a folder workspace permanently unrecoverable (AGENTS.md requires folder
 * workspaces be considered alongside worktrees). Null when neither names a path — the scan has
 * no scope to ask about, and guessing one would scope the resume to the wrong directory.
 */
export function paneAgentResumeScopePath(source: {
  worktreePath?: string | null
  folderWorkspacePath?: string | null
}): string | null {
  for (const raw of [source.worktreePath, source.folderWorkspacePath]) {
    const path = typeof raw === 'string' ? raw.trim() : ''
    if (path.length > 0) {
      return path
    }
  }
  return null
}
