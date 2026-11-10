/** Where one remote worker landed, and which coordinator terminal sent it. */
export type DelegatedWorktreePlacementRow = {
  dispatch_id: string
  environment_id: string
  remote_worktree_id: string
  creator_handle: string | null
  creator_pane_key: string | null
}
