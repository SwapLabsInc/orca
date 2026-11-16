import { describe, expect, it } from 'vitest'
import type { RemoteServerUpdateSupport } from './remote-server-update'
import {
  parseServerUpdateHelpUrl,
  readRemoteServerUpdateSupport,
  SERVER_UPDATE_HELP_URL_ENV,
  SERVER_UPDATE_HELP_URL_MAX_LENGTH
} from './remote-server-update-help-url'

const HELP_URL = 'https://example.com/runbooks/orca-update?host=dev#converge'

const manual: RemoteServerUpdateSupport = {
  installMode: 'unsupported-headless-serve',
  automatic: false,
  reason: 'manual-service-update-required'
}

/** What a peer actually sent: JSON, whatever the type says. */
function overTheWire(value: unknown): RemoteServerUpdateSupport {
  return JSON.parse(JSON.stringify(value))
}

describe('parseServerUpdateHelpUrl', () => {
  it('names the variable the host reads', () => {
    expect(SERVER_UPDATE_HELP_URL_ENV).toBe('ORCA_SERVER_UPDATE_HELP_URL')
  })

  it('accepts an absolute https URL unchanged', () => {
    expect(parseServerUpdateHelpUrl(HELP_URL)).toBe(HELP_URL)
  })

  it.each([
    ['http', 'http://example.com/runbook'],
    ['another scheme', 'file:///etc/passwd'],
    ['a script scheme', 'javascript:alert(1)'],
    ['relative', '/runbooks/orca-update'],
    ['scheme-relative', '//example.com/runbook'],
    ['a bare host', 'example.com/runbook'],
    ['empty', ''],
    ['a newline', 'https://example.com/\nrunbook'],
    ['a tab', 'https://example.com/\trunbook'],
    ['a NUL', 'https://example.com/\u0000'],
    ['a trailing newline', 'https://example.com/runbook\n'],
    ['a DEL', 'https://example.com/\u007f'],
    ['a C1 control', 'https://example.com/\u0085'],
    ['an unparseable host', 'https://exa mple.com/']
  ])('rejects %s', (_label, value) => {
    expect(parseServerUpdateHelpUrl(value)).toBeNull()
  })

  it('accepts the longest allowed value and rejects one character more', () => {
    const prefix = 'https://example.com/'
    const longest = prefix + 'a'.repeat(SERVER_UPDATE_HELP_URL_MAX_LENGTH - prefix.length)
    expect(longest).toHaveLength(2048)
    expect(parseServerUpdateHelpUrl(longest)).toBe(longest)
    expect(parseServerUpdateHelpUrl(`${longest}a`)).toBeNull()
  })

  it.each([
    ['a number', 42],
    ['null', null],
    ['undefined', undefined],
    ['an object', { href: HELP_URL }],
    ['an array', [HELP_URL]]
  ])('rejects %s', (_label, value) => {
    expect(parseServerUpdateHelpUrl(value)).toBeNull()
  })
})

describe('readRemoteServerUpdateSupport', () => {
  it('new client against new host: keeps a valid link', () => {
    expect(readRemoteServerUpdateSupport(overTheWire({ ...manual, helpUrl: HELP_URL }))).toEqual({
      ...manual,
      helpUrl: HELP_URL
    })
  })

  it('new client against old host: a support without the field reads exactly as sent', () => {
    const sent = overTheWire(manual)
    const read = readRemoteServerUpdateSupport(sent)
    expect(read).toBe(sent)
    expect(read).not.toHaveProperty('helpUrl')
  })

  it('new client against old host: a status without support reads as none', () => {
    expect(readRemoteServerUpdateSupport(undefined)).toBeNull()
    expect(readRemoteServerUpdateSupport(null)).toBeNull()
  })

  it.each([
    ['a number', 42],
    ['null', null],
    ['an object', { href: HELP_URL }],
    ['http', 'http://example.com/runbook'],
    ['a script scheme', 'javascript:alert(1)'],
    ['control characters', 'https://example.com/\nrunbook'],
    ['over-long', `https://example.com/${'a'.repeat(SERVER_UPDATE_HELP_URL_MAX_LENGTH)}`]
  ])('drops a malformed link (%s) and keeps the rest of the support', (_label, helpUrl) => {
    const read = readRemoteServerUpdateSupport(overTheWire({ ...manual, helpUrl }))
    expect(read).toEqual(manual)
    expect(read).not.toHaveProperty('helpUrl')
  })

  it('drops a link from a host that updates automatically', () => {
    const automatic = {
      installMode: 'supervised-headless-serve',
      automatic: true,
      reason: 'available'
    }
    const read = readRemoteServerUpdateSupport(overTheWire({ ...automatic, helpUrl: HELP_URL }))
    expect(read).toEqual(automatic)
    expect(read).not.toHaveProperty('helpUrl')
  })

  it('drops a link from a host whose manual reason is not its deployment', () => {
    const unpackaged = { installMode: 'interactive', automatic: false, reason: 'unpackaged-build' }
    expect(
      readRemoteServerUpdateSupport(overTheWire({ ...unpackaged, helpUrl: HELP_URL }))
    ).toEqual(unpackaged)
  })

  it('passes a non-object through instead of throwing', () => {
    expect(readRemoteServerUpdateSupport(overTheWire('nonsense'))).toBe('nonsense')
  })

  it('old client against new host: the members an older build reads by name are unchanged', () => {
    // Why by name: builds before the field read these three off the raw reply, with no schema to refuse a fourth.
    const sent = overTheWire({ ...manual, helpUrl: HELP_URL })
    expect([sent.installMode, sent.automatic, sent.reason]).toEqual([
      manual.installMode,
      manual.automatic,
      manual.reason
    ])
  })
})
