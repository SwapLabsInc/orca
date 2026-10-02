// Why the explicit row: a missing tabsByWorktree row means the workspace's inventory has not
// arrived (or it was never initialized), and offering New Terminal then races the host's own
// terminals into duplicates (#21630). Only an accepted empty row proves the workspace is empty.
export function shouldShowTabGroupEmptyState(args: {
  workspaceSessionReady: boolean
  tabsByWorktree: Readonly<Record<string, readonly unknown[]>>
  worktreeId: string
  groupTabCount: number
}): boolean {
  return (
    args.workspaceSessionReady &&
    args.groupTabCount === 0 &&
    Object.hasOwn(args.tabsByWorktree, args.worktreeId) &&
    args.tabsByWorktree[args.worktreeId]?.length === 0
  )
}
