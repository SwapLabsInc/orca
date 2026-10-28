import { describe, expect, it } from 'vitest'
import { TerminalRunFactsRegister } from './terminal-run-facts'

describe('terminal run facts', () => {
  it('keeps driving input before publication across the exact reserved commit', () => {
    const facts = new TerminalRunFactsRegister()
    facts.recordInput('pending', 'driving', 'x', 100)
    facts.reserveSpawnCommit({ id: 'pending', incarnationId: 'inc-1' })
    facts.recordSpawnCommit({ id: 'pending', incarnationId: 'inc-1' })
    expect(facts.read('pending', 'inc-1').firstUserInputAt).toBe(100)
    facts.reserveSpawnCommit({ id: 'pending', incarnationId: 'inc-2' })
    facts.recordInput('pending', 'driving', 'x', 200)
    facts.recordSpawnCommit({ id: 'pending', incarnationId: 'inc-2' })
    expect(facts.read('pending', 'inc-2').firstUserInputAt).toBe(200)
    facts.delete('pending')
    facts.reserveSpawnCommit({ id: 'pending', incarnationId: 'inc-3' })
    facts.recordSpawnCommit({ id: 'pending', incarnationId: 'inc-3' })
    expect(facts.read('pending', 'inc-3').firstUserInputAt).toBeNull()
  })
  it('reads a run main never saw committed as not fresh', () => {
    expect(new TerminalRunFactsRegister().read('pty-1', 'inc-1')).toEqual({
      freshSpawn: false,
      firstUserInputAt: null
    })
  })

  it('keeps the first user input across later input and a re-registration of the same process', () => {
    const facts = new TerminalRunFactsRegister()
    facts.recordSpawnCommit({ id: 'pty-1', incarnationId: 'inc-1' })
    facts.recordInput('pty-1', 'driving', 'ls\r', 100)
    facts.recordInput('pty-1', 'driving', 'ls\r', 200)

    facts.recordSpawnCommit({ id: 'pty-1', incarnationId: 'inc-1', isReattach: true })

    expect(facts.read('pty-1', 'inc-1')).toEqual({ freshSpawn: true, firstUserInputAt: 100 })
  })

  it('starts a new process clean', () => {
    const facts = new TerminalRunFactsRegister()
    facts.recordSpawnCommit({ id: 'pty-1', incarnationId: 'inc-1' })
    facts.recordInput('pty-1', 'driving', 'ls\r', 100)

    facts.recordSpawnCommit({ id: 'pty-1', incarnationId: 'inc-2' }, { tabId: 'source-tab' })

    expect(facts.read('pty-1', 'inc-2')).toEqual({ freshSpawn: true, firstUserInputAt: null })
    expect(facts.read('pty-1', 'inc-1')).toEqual({ freshSpawn: false, firstUserInputAt: null })
  })

  it('dates only the processes main started, across a re-registration of the same one', () => {
    const facts = new TerminalRunFactsRegister()
    facts.recordSpawnCommit({
      id: 'pty-1',
      incarnationId: 'inc-1',
      coldRestore: {},
      spawnRequestedAt: 100
    })
    facts.recordSpawnCommit({
      id: 'pty-1',
      incarnationId: 'inc-1',
      isReattach: true,
      spawnRequestedAt: 200
    })
    facts.recordSpawnCommit({
      id: 'pty-2',
      incarnationId: 'inc-9',
      isReattach: true,
      spawnRequestedAt: 300
    })

    expect(facts.readProcessStartedAt('pty-1', 'inc-1')).toBe(100)
    expect(facts.readProcessStartedAt('pty-1', 'inc-0')).toBeNull()
    expect(facts.readProcessStartedAt('pty-2', 'inc-9')).toBeNull()
  })

  it('never reads a reattached process as fresh', () => {
    const facts = new TerminalRunFactsRegister()

    facts.recordSpawnCommit({ id: 'pty-1', incarnationId: 'inc-1', isReattach: true })

    expect(facts.read('pty-1', 'inc-1').freshSpawn).toBe(false)
  })

  it('starts clean when a new process commits without an incarnation', () => {
    const facts = new TerminalRunFactsRegister()
    facts.recordSpawnCommit({ id: 'pty-1' })
    facts.recordInput('pty-1', 'driving', 'ls\r', 100)

    facts.recordSpawnCommit({ id: 'pty-1' })

    expect(facts.read('pty-1', null)).toEqual({ freshSpawn: true, firstUserInputAt: null })
    expect(facts.readLastInputAt('pty-1')).toBeNull()
  })

  it.each([
    ['a reattach', { isReattach: true }],
    ['an adoption', { agentSessionEnsure: { disposition: 'adopted' } }]
  ])('keeps the input of the running process through %s without an incarnation', (_l, commit) => {
    const facts = new TerminalRunFactsRegister()
    facts.recordSpawnCommit({ id: 'pty-1' })
    facts.recordInput('pty-1', 'driving', 'next prompt\r', 100)

    facts.recordSpawnCommit({ id: 'pty-1', ...commit })

    expect(facts.read('pty-1', null)).toEqual({ freshSpawn: false, firstUserInputAt: 100 })
    expect(facts.readLastInputAt('pty-1')).toBe(100)
  })

  it('keeps input recorded before main adopted the process with its first commit', () => {
    const facts = new TerminalRunFactsRegister()
    facts.recordInput('pty-1', 'driving', 'next prompt\r', 100)

    facts.recordSpawnCommit({ id: 'pty-1', incarnationId: 'inc-1', isReattach: true })

    expect(facts.readLastInputAt('pty-1')).toBe(100)
  })

  it('starts clean when a reattach names a different process than the one recorded', () => {
    const facts = new TerminalRunFactsRegister()
    facts.recordSpawnCommit({ id: 'pty-1', incarnationId: 'inc-1' })
    facts.recordInput('pty-1', 'driving', 'ls\r', 100)

    facts.recordSpawnCommit({ id: 'pty-1', incarnationId: 'inc-2', isReattach: true })

    expect(facts.read('pty-1', 'inc-2')).toEqual({ freshSpawn: false, firstUserInputAt: null })
    expect(facts.readLastInputAt('pty-1')).toBeNull()
  })

  it.each([
    ['a launch write', 'launch', 'echo startup\r'],
    ['a query reply', 'query-reply', '\x1b[1;1R'],
    ['driving bytes that are only a terminal reply', 'driving', '\x1b[1;1R'],
    ['driving bytes that are only focus reports', 'driving', '\x1b[I\x1b[O']
  ] as const)('records nothing for %s', (_label, inputKind, data) => {
    const facts = new TerminalRunFactsRegister()
    facts.recordSpawnCommit({ id: 'pty-1', incarnationId: 'inc-1' })

    facts.recordInput('pty-1', inputKind, data, 100)

    expect(facts.read('pty-1', 'inc-1').firstUserInputAt).toBeNull()
  })

  it('records the last input, a launch write included, but no terminal reply', () => {
    const facts = new TerminalRunFactsRegister()
    facts.recordSpawnCommit({ id: 'pty-1', incarnationId: 'inc-1' })
    facts.recordInput('pty-1', 'driving', 'ls\r', 100)
    facts.recordInput('pty-1', 'launch', 'next task\r', 200)
    facts.recordInput('pty-1', 'query-reply', 'answer', 300)
    facts.recordInput('pty-1', 'driving', '\x1b[I', 400)

    expect(facts.read('pty-1', 'inc-1').firstUserInputAt).toBe(100)
    expect(facts.readLastInputAt('pty-1')).toBe(200)

    facts.recordSpawnCommit({ id: 'pty-1', incarnationId: 'inc-1', isReattach: true })
    expect(facts.readLastInputAt('pty-1')).toBe(200)
    facts.recordSpawnCommit({ id: 'pty-1', incarnationId: 'inc-2' })
    expect(facts.readLastInputAt('pty-1')).toBeNull()
  })

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

  it('records the last input on a PTY main adopted without a spawn commit', () => {
    const facts = new TerminalRunFactsRegister()
    facts.recordInput('pty-1', 'driving', 'next task\r', 100)

    expect(facts.readLastInputAt('pty-1')).toBe(100)
    expect(facts.read('pty-1', null).firstUserInputAt).toBeNull()
  })
})
