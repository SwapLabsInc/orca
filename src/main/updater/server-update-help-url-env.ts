import {
  parseServerUpdateHelpUrl,
  SERVER_UPDATE_HELP_URL_ENV,
  SERVER_UPDATE_HELP_URL_MAX_LENGTH
} from '../../shared/remote-server-update-help-url'

export function readServerUpdateHelpUrlEnv(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = env[SERVER_UPDATE_HELP_URL_ENV]
  if (raw === undefined || raw === '') {
    return null
  }
  const helpUrl = parseServerUpdateHelpUrl(raw)
  if (helpUrl === null) {
    // Why the value is not echoed: it is unvalidated input, control characters included.
    console.warn(
      `[updater] ignoring ${SERVER_UPDATE_HELP_URL_ENV}: expected an absolute https URL of at most ${SERVER_UPDATE_HELP_URL_MAX_LENGTH} characters`
    )
  }
  return helpUrl
}
