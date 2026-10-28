import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { TeamClaudeLeaderboardError } from './teamclaude-leaderboard-error'

export type TeamClaudeWrapperConfig = {
  server: string
  keyFile: string
}

const CONFIG_MAX_BYTES = 64 * 1024
const KEY_FILE_MAX_BYTES = 4096
const PRINTABLE_KEY = /^[\x21-\x7e]{1,1024}$/

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The path `teamclaude wrappers` itself reads: an empty XDG_CONFIG_HOME counts as unset. */
export function teamClaudeWrapperConfigPath(env: NodeJS.ProcessEnv, home: string): string {
  return join(env.XDG_CONFIG_HOME || join(home, '.config'), 'teamclaude', 'wrappers.json')
}

/** Null when this host has no wrapper install; otherwise the wrapper's own acceptance rules apply. */
export async function readTeamClaudeWrapperConfig(
  path: string
): Promise<TeamClaudeWrapperConfig | null> {
  const invalid = new TeamClaudeLeaderboardError('TeamClaude wrapper config is invalid')
  let text: string
  try {
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      const info = await file.stat()
      const ownedByOther = process.getuid !== undefined && info.uid !== process.getuid()
      if (!info.isFile() || info.mode & 0o077 || info.size > CONFIG_MAX_BYTES || ownedByOther) {
        throw invalid
      }
      text = await file.readFile('utf8')
    } finally {
      await file.close()
    }
  } catch (error) {
    if (isMissingPath(error)) {
      return null
    }
    throw invalid
  }
  let config: unknown
  try {
    config = JSON.parse(text)
  } catch {
    throw invalid
  }
  if (!isRecord(config)) {
    throw invalid
  }
  if (config.installed === false) {
    return null
  }
  const { server, keyFile } = config
  if (typeof server !== 'string' || typeof keyFile !== 'string' || !isAbsolute(keyFile)) {
    throw invalid
  }
  return { server, keyFile }
}

function isMissingPath(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    (error.code === 'ENOENT' || error.code === 'ENOTDIR')
  )
}

/** The operator key; callers must never log, persist or return it. */
export async function readTeamClaudeKey(keyFile: string): Promise<string> {
  const invalid = new TeamClaudeLeaderboardError('TeamClaude key file is invalid')
  let raw: string
  try {
    const file = await open(keyFile, constants.O_RDONLY | constants.O_NONBLOCK)
    try {
      const info = await file.stat()
      if (!info.isFile() || info.size > KEY_FILE_MAX_BYTES) {
        throw invalid
      }
      const buffer = Buffer.alloc(KEY_FILE_MAX_BYTES + 1)
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0)
      if (bytesRead > KEY_FILE_MAX_BYTES) {
        throw invalid
      }
      raw = buffer.subarray(0, bytesRead).toString('utf8')
    } finally {
      await file.close()
    }
  } catch {
    throw invalid
  }
  const key = raw.trim()
  if (!PRINTABLE_KEY.test(key)) {
    throw invalid
  }
  return key
}
