import { afterEach, describe, expect, it, vi } from 'vitest'
import { readServerUpdateHelpUrlEnv } from './server-update-help-url-env'

const HELP_URL = 'https://example.com/runbooks/orca-update'

describe('readServerUpdateHelpUrlEnv', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('reads a valid https URL without warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(readServerUpdateHelpUrlEnv({ ORCA_SERVER_UPDATE_HELP_URL: HELP_URL })).toBe(HELP_URL)
    expect(warn).not.toHaveBeenCalled()
  })

  it.each([
    ['unset', {}],
    ['empty', { ORCA_SERVER_UPDATE_HELP_URL: '' }]
  ])('reads %s as no link, silently', (_label, env) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(readServerUpdateHelpUrlEnv(env)).toBeNull()
    expect(warn).not.toHaveBeenCalled()
  })

  it.each([
    ['http', 'http://example.com/runbook'],
    ['relative', '/runbooks/orca-update'],
    ['control characters', 'https://example.com/\nrunbook'],
    ['over-long', `https://example.com/${'a'.repeat(2048)}`],
    ['whitespace only', '   ']
  ])('ignores %s with one warning that does not echo the value', (_label, value) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(readServerUpdateHelpUrlEnv({ ORCA_SERVER_UPDATE_HELP_URL: value })).toBeNull()
    expect(warn).toHaveBeenCalledOnce()
    expect(warn.mock.calls[0]?.[0]).toContain('ORCA_SERVER_UPDATE_HELP_URL')
    expect(warn.mock.calls[0]?.join(' ')).not.toContain(value)
  })

  it('reads the process environment by default', () => {
    vi.stubEnv('ORCA_SERVER_UPDATE_HELP_URL', HELP_URL)
    try {
      expect(readServerUpdateHelpUrlEnv()).toBe(HELP_URL)
    } finally {
      vi.unstubAllEnvs()
    }
  })
})
