import { useMemo } from 'react'
import { useAppStore } from '@/store/index'
import { useAppStoreWithHostStatuses } from '@/store/slices/runtime-status/views/use-runtime-status-view'
import { selectSidebarLineageParentIdentities } from '@/store/slices/worktrees/metadata/cross-store-lineage-parents'

/** The row plan's nesting inputs as one memo dependency: lineage parents plus delegated workers. */
export function useSidebarLineageNestingInputs() {
  const lineageParentIdentities = useAppStoreWithHostStatuses(selectSidebarLineageParentIdentities)
  const delegatedWorktreeEdges = useAppStore((s) => s.delegatedWorktreeEdges)
  return useMemo(
    () => ({ lineageParentIdentities, delegatedWorktreeEdges }),
    [lineageParentIdentities, delegatedWorktreeEdges]
  )
}
