import { useCallback, useEffect, useRef, useState } from 'react'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
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
 */
export function AgentResumeChooser({
  candidates,
  onResume,
  onDismiss
}: AgentResumeChooserProps): React.JSX.Element | null {
  const rows = buildAgentResumeChooserRows(candidates)
  const [selected, setSelected] = useState(0)
  const containerRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    containerRef.current?.focus()
  }, [])

  // Why: a shrinking list (a sibling pane claimed one) must not strand the cursor past the end.
  useEffect(() => {
    setSelected((current) => (current < rows.length ? current : Math.max(0, rows.length - 1)))
  }, [rows.length])

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>): void => {
      if (rows.length === 0) {
        return
      }
      // Number/arrow/Enter/Escape only: no platform-specific modifier, so this reads
      // the same on macOS, Linux and Windows.
      if (event.key === 'Escape') {
        event.preventDefault()
        onDismiss()
        return
      }
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
    [onDismiss, onResume, rows, selected]
  )

  if (rows.length === 0) {
    return null
  }

  return (
    <div
      ref={containerRef}
      role="listbox"
      tabIndex={0}
      aria-label={translate(
        'components.terminalPane.AgentResumeChooser.label',
        'Choose a session to resume'
      )}
      onKeyDown={handleKeyDown}
      className="absolute inset-0 z-10 flex items-center justify-center bg-background/80 outline-none"
      data-testid="agent-resume-chooser"
    >
      <div className="w-full max-w-lg rounded-xl border border-border bg-card text-card-foreground shadow-floating">
        <div className="border-b border-border px-4 py-3">
          <p className="text-sm font-medium">
            {translate(
              'components.terminalPane.AgentResumeChooser.title',
              'Which session should this terminal resume?'
            )}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            {translate(
              'components.terminalPane.AgentResumeChooser.help',
              'Press a number or Enter to resume, Esc for a plain shell.'
            )}
          </p>
        </div>
        <ul className="py-1">
          {rows.map((row, index) => (
            <li key={row.candidate.providerSession.id}>
              <button
                type="button"
                role="option"
                aria-selected={index === selected}
                onMouseEnter={() => setSelected(index)}
                onClick={() => onResume(row.candidate)}
                className={cn(
                  'flex w-full items-baseline gap-3 px-4 py-2 text-left text-sm',
                  index === selected ? 'bg-accent text-accent-foreground' : 'text-foreground'
                )}
              >
                <span className="w-4 shrink-0 font-mono text-xs text-muted-foreground">
                  {index + 1}
                </span>
                <span className="min-w-0 flex-1 truncate">{row.title}</span>
                <span className="shrink-0 font-mono text-xs text-muted-foreground">
                  {row.agentLabel} · {row.messageCount} · {row.age}
                </span>
              </button>
            </li>
          ))}
        </ul>
        <div className="border-t border-border px-4 py-2">
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
        </div>
      </div>
    </div>
  )
}
