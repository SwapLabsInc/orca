import { describe, expect, it } from 'vitest'
import { TerminalRunFactsRegister } from './terminal-run-facts'

describe('terminal run facts typed input', () => {
  // A draft is what typing the mailbox pointer would land in; only a submit or clear ends it.
  it.each([
    ['a keystroke', ['h'], true],
    ['Enter', ['hi', '\r'], false],
    ['a line sent with its Enter', ['ship it\r'], false],
    ['Ctrl+C', ['hi', '\x03'], false],
    ["an agent TUI's clear burst", ['hi', '\x15\x15\x0b'], false],
    ['Shift+Enter as ESC CR', ['hi', '\x1b\r'], true],
    ['Kitty Enter', ['hi', '\x1b[13u'], false],
    ['Kitty Enter with an explicit no-modifier', ['hi', '\x1b[13;1u'], false],
    ['Shift+Enter as CSI u', ['\r', '\x1b[13;2u'], true],
    ['Ctrl+J', ['\r', '\n'], true],
    ['a bracketed paste', ['\r', '\x1b[200~a\rb\x1b[201~'], true]
  ])('tracks an unsent draft through %s', (_label, chunks, unsubmitted) => {
    const facts = new TerminalRunFactsRegister()
    chunks.forEach((data, index) => facts.recordInput('pty-1', 'driving', data, 100 + index))

    expect(facts.readTypedInput('pty-1')).toMatchObject({ at: 99 + chunks.length, unsubmitted })
  })

  it('counts typed input from clients only, without mouse reports, until a new process', () => {
    const facts = new TerminalRunFactsRegister()
    facts.recordSpawnCommit({ id: 'pty-1', incarnationId: 'inc-1' })
    facts.recordInput('pty-1', 'orchestration', 'You have 1 orchestration message.', 100)
    facts.recordInput('pty-1', 'launch', 'start here', 100)
    expect(facts.readTypedInput('pty-1')).toBeNull()

    facts.recordInput('pty-1', 'driving', 'a', 200)
    const first = facts.readTypedInput('pty-1')?.serial ?? 0
    facts.recordInput('pty-1', 'driving', '\x1b[<64;10;5M\x1b[<65;10;5M', 300)
    expect(facts.readTypedInput('pty-1')).toEqual({ at: 200, serial: first, unsubmitted: true })
    facts.recordInput('pty-1', 'driving', '\r', 400)
    expect(facts.readTypedInput('pty-1')?.serial).toBeGreaterThan(first)

    facts.recordSpawnCommit({ id: 'pty-1', incarnationId: 'inc-2' })
    expect(facts.readTypedInput('pty-1')).toBeNull()
  })
})
