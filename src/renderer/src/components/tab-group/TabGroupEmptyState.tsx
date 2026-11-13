import { TerminalSquare } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ShortcutKeyCombo } from '@/components/ShortcutKeyCombo'
import { useShortcutKeyDetails } from '@/hooks/useShortcutLabel'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store/index'
import { shouldShowTabGroupEmptyState } from './tab-group-empty-state-visibility'

// Why: a workspace whose last tab a runtime closed (e.g. a released orchestration worker) stays
// active, and a runtime-owned one is deliberately not re-seeded, so the body needs its own way back.
// Why the whole model and commands: TabGroupPanel is at its line limit, so its mount is one line.
export function TabGroupEmptyState({
  worktreeId,
  model,
  commands
}: {
  worktreeId: string
  model: { groupTabs: readonly unknown[] }
  commands: { newTerminalTab: () => void }
}): React.JSX.Element | null {
  const shown = useAppStore((state) =>
    shouldShowTabGroupEmptyState({
      workspaceSessionReady: state.workspaceSessionReady,
      tabsByWorktree: state.tabsByWorktree,
      worktreeId,
      groupTabCount: model.groupTabs.length
    })
  )
  return shown ? <NewTerminalPrompt onNewTerminal={commands.newTerminalTab} /> : null
}

function NewTerminalPrompt({ onNewTerminal }: { onNewTerminal: () => void }): React.JSX.Element {
  const shortcut = useShortcutKeyDetails('tab.newTerminal')
  return (
    <div className="absolute inset-0 flex items-center justify-center" data-tab-group-empty-state>
      <Button type="button" variant="ghost" size="sm" onClick={onNewTerminal}>
        <TerminalSquare />
        {translate('auto.components.tab.bar.TabBar.d364f3c8d4', 'New Terminal')}
        {shortcut.keys.length > 0 ? (
          <ShortcutKeyCombo keys={shortcut.keys} doubleTap={shortcut.doubleTap} />
        ) : null}
      </Button>
    </div>
  )
}
