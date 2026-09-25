import { useEffect, useState } from 'react'

export type TitlebarAppVersion = {
  /** The upstream Orca version the build is based on, e.g. `1.4.197` or `1.4.198-rc.1`. */
  upstream: string
  /** The last segment of the fork suffix, e.g. `3` for `1.4.197-swaplabs.3`. */
  revision: string | null
}

const SWAPLABS_SUFFIX = /[-.]swaplabs(?:\.(.*))?$/

export function parseTitlebarAppVersion(version: string): TitlebarAppVersion | null {
  const trimmed = version.trim()
  if (!trimmed) {
    return null
  }
  const match = SWAPLABS_SUFFIX.exec(trimmed)
  if (!match) {
    return { upstream: trimmed, revision: null }
  }
  const revision = match[1]?.split('.').pop()
  return {
    upstream: trimmed.slice(0, match.index),
    revision: revision ? revision : null
  }
}

export function useTitlebarAppVersion(): TitlebarAppVersion | null {
  const [appVersion, setAppVersion] = useState<TitlebarAppVersion | null>(null)
  useEffect(() => {
    let cancelled = false
    window.api.updater
      .getVersion()
      .then((version) => {
        if (!cancelled) {
          setAppVersion(parseTitlebarAppVersion(version))
        }
      })
      // Why: without a version the label stays "Orca (SwapLabs)" rather than failing the titlebar.
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])
  return appVersion
}
