import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  readTeamClaudeKey,
  readTeamClaudeWrapperConfig,
  teamClaudeWrapperConfigPath
} from './teamclaude-wrapper-config'

describe('teamClaudeWrapperConfigPath', () => {
  it('follows XDG_CONFIG_HOME and treats an empty value as unset, as the wrapper does', () => {
    expect(teamClaudeWrapperConfigPath({ XDG_CONFIG_HOME: '/xdg' }, '/home/u')).toBe(
      join('/xdg', 'teamclaude', 'wrappers.json')
    )
    expect(teamClaudeWrapperConfigPath({ XDG_CONFIG_HOME: '' }, '/home/u')).toBe(
      join('/home/u', '.config', 'teamclaude', 'wrappers.json')
    )
  })
})

// The wrapper's private-file rules are POSIX modes; the leaderboard never reads them on Windows.
describe.skipIf(process.platform === 'win32')('TeamClaude wrapper files', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'teamclaude-wrapper-config-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  function writePrivate(name: string, content: string | Buffer, mode = 0o600): string {
    const path = join(dir, name)
    writeFileSync(path, content)
    chmodSync(path, mode)
    return path
  }

  it('reads the server and key file of an installed wrapper', async () => {
    const keyFile = join(dir, 'key')
    const path = writePrivate(
      'wrappers.json',
      JSON.stringify({ version: 2, server: 'devservices1.tailfa7aa.ts.net:3456', keyFile })
    )

    await expect(readTeamClaudeWrapperConfig(path)).resolves.toEqual({
      server: 'devservices1.tailfa7aa.ts.net:3456',
      keyFile
    })
  })

  it('treats a missing or uninstalled wrapper as not configured', async () => {
    const uninstalled = writePrivate(
      'wrappers.json',
      JSON.stringify({ installed: false, server: 'x.ts.net', keyFile: '/k' })
    )

    await expect(readTeamClaudeWrapperConfig(join(dir, 'absent.json'))).resolves.toBeNull()
    await expect(readTeamClaudeWrapperConfig(uninstalled)).resolves.toBeNull()
  })

  it.each([
    ['group-readable', JSON.stringify({ server: 'x.ts.net', keyFile: '/k' }), 0o640],
    ['malformed JSON', '{"server":', 0o600],
    ['a relative key file', JSON.stringify({ server: 'x.ts.net', keyFile: 'key' }), 0o600],
    ['no server', JSON.stringify({ keyFile: '/k' }), 0o600],
    ['an array', '[]', 0o600]
  ])('rejects a config that is %s', async (_label, content, mode) => {
    const path = writePrivate('wrappers.json', content, mode)

    await expect(readTeamClaudeWrapperConfig(path)).rejects.toThrow(
      'TeamClaude wrapper config is invalid'
    )
  })

  it('trims the key file the way the wrapper does', async () => {
    await expect(readTeamClaudeKey(writePrivate('key', 'tc-admin-abc123\n'))).resolves.toBe(
      'tc-admin-abc123'
    )
  })

  it.each([
    ['empty', ''],
    ['whitespace inside', 'tc admin'],
    ['a control character', 'tc\u0007admin'],
    ['non-ASCII', 'tc-admin-é'],
    ['over 4 KiB', 'k'.repeat(4097)]
  ])('rejects a key file that is %s', async (_label, content) => {
    await expect(readTeamClaudeKey(writePrivate('key', content))).rejects.toThrow(
      'TeamClaude key file is invalid'
    )
  })

  it('rejects a key path that is not a regular file', async () => {
    const directory = join(dir, 'key-dir')
    mkdirSync(directory)

    await expect(readTeamClaudeKey(directory)).rejects.toThrow('TeamClaude key file is invalid')
    await expect(readTeamClaudeKey(join(dir, 'absent'))).rejects.toThrow(
      'TeamClaude key file is invalid'
    )
  })
})
