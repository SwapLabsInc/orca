// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentResumeCandidate } from '../../../../shared/agent-resume-candidate'
import { AgentResumeChooser } from './AgentResumeChooser'

vi.mock('@/i18n/i18n', () => ({
  translate: vi.fn((_key: string, fallback: string) => fallback)
}))

const mountedRoots: Root[] = []

function makeCandidate(id: string, updatedAt: number): AgentResumeCandidate {
  return {
    agent: 'claude',
    providerSession: { key: 'session_id', id },
    cwd: '/w',
    title: `Session ${id}`,
    updatedAt,
    messageCount: 758,
    branch: null,
    executionHostId: null
  }
}

const CANDIDATES = [
  makeCandidate('a521d69e-9181-481c-ab8e-998a1881b731', 1_789_000_000_000),
  makeCandidate('b171319f-6711-4537-89be-00f26ccc7e32', 1_788_000_000_000)
]

async function renderChooser(onResume = vi.fn()): Promise<{ onResume: typeof onResume }> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  mountedRoots.push(root)
  await act(async () => {
    root.render(
      <AgentResumeChooser candidates={CANDIDATES} onResume={onResume} onDismiss={vi.fn()} />
    )
  })
  return { onResume }
}

function rows(): HTMLElement[] {
  return [...document.body.querySelectorAll<HTMLElement>('[role="option"]')]
}

function listbox(): HTMLElement {
  const element = document.body.querySelector<HTMLElement>('[role="listbox"]')
  if (!element) {
    throw new Error('listbox not rendered')
  }
  return element
}

async function pressKey(key: string): Promise<void> {
  await act(async () => {
    listbox().dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
  })
}

afterEach(() => {
  for (const root of mountedRoots.splice(0)) {
    act(() => root.unmount())
  }
  document.body.innerHTML = ''
})

describe('AgentResumeChooser', () => {
  // A blocking decision surface has to trap focus, or Tab reaches the xterm underneath and the
  // user can type into the very shell a row is about to replace.
  it('renders through the Dialog primitive with a modal surface', async () => {
    await renderChooser()
    const content = document.body.querySelector('[data-slot="dialog-content"]')
    expect(content).not.toBeNull()
    expect(content?.getAttribute('data-testid')).toBe('agent-resume-chooser')
    expect(document.body.querySelector('[data-slot="dialog-overlay"]')).not.toBeNull()
  })

  it('focuses the listbox rather than the dialog close button', async () => {
    await renderChooser()
    expect(document.activeElement).toBe(listbox())
  })

  // CORRECTNESS: native buttons let Tab move real focus without moving `selected`, and Enter then
  // resumed a different session than the focused one — a silent fork of the wrong transcript.
  it('gives rows no focus of their own, so focus and selection cannot diverge', async () => {
    await renderChooser()
    for (const row of rows()) {
      expect(row.tagName).not.toBe('BUTTON')
      expect(row.hasAttribute('tabindex')).toBe(false)
    }
    expect(listbox().getAttribute('aria-activedescendant')).toBe(rows()[0].id)
  })

  it('resumes the row aria-selected names after the cursor moves', async () => {
    const { onResume } = await renderChooser()
    await pressKey('ArrowDown')

    const selectedRows = rows().filter((row) => row.getAttribute('aria-selected') === 'true')
    expect(selectedRows).toHaveLength(1)
    expect(listbox().getAttribute('aria-activedescendant')).toBe(selectedRows[0].id)

    await pressKey('Enter')
    expect(onResume).toHaveBeenCalledWith(CANDIDATES[1])
  })

  // docs/STYLEGUIDE.md: flat bg-accent is near-invisible on a light dialog surface, and a lost
  // cursor here means resuming the wrong transcript.
  it('marks the selected row with the documented jump-palette selection surface', async () => {
    await renderChooser()
    const [first, second] = rows()
    expect(first.className).toContain('jump-palette-item')
    expect(first.getAttribute('data-selected')).toBe('true')
    expect(second.hasAttribute('data-selected')).toBe(false)

    await pressKey('ArrowDown')
    expect(rows()[0].hasAttribute('data-selected')).toBe(false)
    expect(rows()[1].getAttribute('data-selected')).toBe('true')
  })

  it('resumes by number key', async () => {
    const { onResume } = await renderChooser()
    await pressKey('2')
    expect(onResume).toHaveBeenCalledWith(CANDIDATES[1])
  })
})
