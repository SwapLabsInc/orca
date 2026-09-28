import type { RemoteServerUpdateSupport } from './remote-server-update'

export const SERVER_UPDATE_HELP_URL_ENV = 'ORCA_SERVER_UPDATE_HELP_URL' as const
export const SERVER_UPDATE_HELP_URL_MAX_LENGTH = 2048

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) {
      return true
    }
  }
  return false
}

/** One rule for the host's environment read and the client's wire read, so neither accepts what the other refuses. */
export function parseServerUpdateHelpUrl(value: unknown): string | null {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > SERVER_UPDATE_HELP_URL_MAX_LENGTH ||
    // Why before parsing: the URL parser strips tabs and newlines instead of refusing them.
    hasControlCharacter(value)
  ) {
    return null
  }
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    return null
  }
  return parsed.protocol === 'https:' ? value : null
}

/** Reads a peer's support. A bad `helpUrl` costs only itself, never the support it rode in on. */
export function readRemoteServerUpdateSupport(
  support: RemoteServerUpdateSupport | null | undefined
): RemoteServerUpdateSupport | null {
  if (support === null || support === undefined) {
    return null
  }
  // Why: the type is a claim about a peer; `in` throws on a non-object.
  if (typeof support !== 'object' || !('helpUrl' in support)) {
    return support
  }
  const { helpUrl, ...rest } = support
  const valid =
    rest.reason === 'manual-service-update-required' && rest.automatic !== true
      ? parseServerUpdateHelpUrl(helpUrl)
      : null
  return valid === null ? rest : { ...rest, helpUrl: valid }
}
