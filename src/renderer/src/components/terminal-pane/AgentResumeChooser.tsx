import { useCallback, useEffect, useRef, useState } from 'react'
import { translate } from '@/i18n/i18n'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import type { AgentResumeCandidate } from '../../../../shared/agent-resume-candidate'
import { buildAgentResumeChooserRows } from './agent-resume-chooser-rows'

type AgentResumeChooserProps = {
  candidates: readonly AgentResumeCandidate[]
  onResume: (candidate: AgentResumeCandidate) => void
  onDismiss: () => void
}

/**
 * The one visible surface of agent auto-resume. It appears only when the resolver
 * refused to decide, because resuming the wrong transcript forks it unrecoverably.
 *
 * It renders INSTEAD of the pane's spawn, never over a running shell: selecting a row
 * hands the resume to the spawn that has been held back, so no resume command is ever
 * typed into a live shell (docs/reference/omp-resume-transcript-locator.md). Dismissing
 * spawns the plain shell, which is exactly the behaviour without this feature.
 *
 * Why the `Dialog` primitive and not an inline overlay: this is a blocking decision, and an
 * overlay traps nothing — Tab reached the xterm underneath, so the user could type into the very
 * shell a row was about to replace, and focus never returned where it started.
 *
 * Why the rows are not buttons: focus and selection have to be ONE value. Native buttons let Tab
 * move real focus without moving `selected`, and Enter then resumed `rows[selected]` — a different
 * session than the focused one, silently forking the wrong transcript. The listbox alone takes
 * focus and names the active row through `aria-activedescendant`, so there is nothing to diverge.
 */
export function AgentResumeChooser({
  candidates,
  onResume,
  onDismiss
}: AgentResumeChooserProps): React.JSX.Element | null {
  const rows = buildAgentResumeChooserRows(candidates)
  const [selected, setSelected] = useState(0)
  const listboxRef = useRef<HTMLDivElement | null>(null)

  // Why: a shrinking list (a sibling pane claimed one) must not strand the cursor past the end.
  useEffect(() => {
    setSelected((current) => (current < rows.length ? current : Math.max(0, rows.length - 1)))
  }, [rows.length])

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>): void => {
      if (rows.length === 0) {
        return
      }
      // Number/arrow/Enter only: no platform-specific modifier, so this reads the same on
      // macOS, Linux and Windows. Escape is the Dialog's, which also restores focus.
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        setSelected((current) => (current + 1) % rows.length)
        return
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault()
        setSelected((current) => (current - 1 + rows.length) % rows.length)
        return
      }
      // The Radix focus trap also holds the close and dismiss buttons, so one Tab moves focus off
      // this listbox and every key below stops firing while the selected row still looks active —
      // a dialog whose help text promises "press a number or Enter" with a dead keyboard. Rows are
      // deliberately not tabbable, so holding focus here costs no reachable stop.
      if (event.key === 'Tab' && !event.altKey && !event.ctrlKey && !event.metaKey) {
        event.preventDefault()
        return
      }
      if (event.key === 'Enter') {
        event.preventDefault()
        const row = rows[selected]
        if (row) {
          onResume(row.candidate)
        }
        return
      }
      const digit = Number.parseInt(event.key, 10)
      if (Number.isInteger(digit) && digit >= 1 && digit <= rows.length) {
        event.preventDefault()
        onResume(rows[digit - 1].candidate)
      }
    },
    [onResume, rows, selected]
  )

  if (rows.length === 0) {
    return null
  }

  const activeRowId = `agent-resume-choice-${rows[selected]?.candidate.providerSession.id ?? ''}`

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) {
          onDismiss()
        }
      }}
    >
      <DialogContent
        data-testid="agent-resume-chooser"
        // Why redirected: Radix focuses the first tabbable node, which is the close button. The
        // listbox is the decision surface, and arrow keys have to work the moment it opens.
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          listboxRef.current?.focus()
        }}
      >
        <DialogHeader>
          <DialogTitle>
            {translate(
              'components.terminalPane.AgentResumeChooser.title',
              'Which session should this terminal resume?'
            )}
          </DialogTitle>
          <DialogDescription>
            {translate(
              'components.terminalPane.AgentResumeChooser.help',
              'Press a number or Enter to resume, Esc for a plain shell.'
            )}
          </DialogDescription>
        </DialogHeader>
        <div
          ref={listboxRef}
          role="listbox"
          tabIndex={0}
          aria-label={translate(
            'components.terminalPane.AgentResumeChooser.label',
            'Choose a session to resume'
          )}
          aria-activedescendant={activeRowId}
          onKeyDown={handleKeyDown}
          className="-mx-2 flex flex-col gap-0.5 rounded-md outline-none"
        >
          {rows.map((row, index) => (
            <div
              key={row.candidate.providerSession.id}
              id={`agent-resume-choice-${row.candidate.providerSession.id}`}
              role="option"
              aria-selected={index === selected}
              data-selected={index === selected ? 'true' : undefined}
              onMouseEnter={() => setSelected(index)}
              onClick={() => onResume(row.candidate)}
              // `jump-palette-item` is the documented selection surface: flat bg-accent is
              // near-invisible on a light dialog, and the cursor decides which transcript Enter
              // resumes (docs/STYLEGUIDE.md, "List rows").
              className="jump-palette-item flex cursor-pointer items-baseline gap-3 rounded-md border border-transparent px-3 py-2 text-left text-sm text-foreground"
            >
              <span className="w-4 shrink-0 font-mono text-xs text-muted-foreground">
                {index + 1}
              </span>
              <span className="min-w-0 flex-1 truncate">{row.title}</span>
              <span className="shrink-0 font-mono text-xs text-muted-foreground">
                {row.agentLabel} · {row.messageCount} · {row.age}
              </span>
            </div>
          ))}
        </div>
        <DialogFooter>
          <button
            type="button"
            onClick={onDismiss}
            className="text-xs text-muted-foreground hover:text-foreground"
          >
            {translate(
              'components.terminalPane.AgentResumeChooser.dismiss',
              'Start a plain shell instead'
            )}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
