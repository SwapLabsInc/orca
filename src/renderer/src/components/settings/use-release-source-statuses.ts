import { useCallback, useEffect, useRef, useState } from 'react'
import { readIpcErrorDetail } from '@/lib/ipc-error'
import type { ReleaseSourceStatus } from '../../../../shared/update-status-types'

export type ReleaseSourceStatusesState = {
  /** Null until the first list resolves; a refresh keeps the previous rows until the next one lands. */
  sources: ReleaseSourceStatus[] | null
  loading: boolean
  /** The whole read failed (IPC rejection), as opposed to one source's own `error`. */
  error: string | null
  reload: (options?: { force?: boolean }) => Promise<void>
}

/**
 * Loads every configured release source with its newest build. `enabled` is false for
 * single-source builds, which never issue the read and keep today's markup untouched.
 */
export function useReleaseSourceStatuses(enabled: boolean): ReleaseSourceStatusesState {
  const [sources, setSources] = useState<ReleaseSourceStatus[] | null>(null)
  const [loading, setLoading] = useState(enabled)
  const [error, setError] = useState<string | null>(null)
  // Why: a mount load and a "Check for updates" refresh can overlap; only the newest
  // request may publish, or a slower earlier list overwrites the fresher one.
  const latestRequestRef = useRef(0)

  const reload = useCallback(async (options?: { force?: boolean }): Promise<void> => {
    const requestId = latestRequestRef.current + 1
    latestRequestRef.current = requestId
    const isStale = (): boolean => latestRequestRef.current !== requestId
    setLoading(true)
    try {
      const next = await window.api.updater.listSources(options)
      if (isStale()) {
        return
      }
      setSources(next)
      setError(null)
    } catch (loadError) {
      if (isStale()) {
        return
      }
      setError(readIpcErrorDetail(loadError) ?? String(loadError))
    } finally {
      if (!isStale()) {
        setLoading(false)
      }
    }
  }, [])

  useEffect(() => {
    if (!enabled) {
      return
    }
    void reload()
    return () => {
      // Why: an unmounted section must not publish; bumping the counter makes every in-flight load stale.
      latestRequestRef.current += 1
    }
  }, [enabled, reload])

  return { sources, loading, error, reload }
}
