import { useCallback, useEffect, useRef, useState } from "react"

export function usePolling(
  fn: () => void | Promise<void>,
  intervalMs: number,
  deps: ReadonlyArray<unknown>,
): void {
  const fnRef = useRef(fn)
  fnRef.current = fn

  useEffect(() => {
    let cancelled = false

    const tick = () => {
      if (cancelled || document.hidden) return
      void fnRef.current()
    }

    tick()
    const id = globalThis.setInterval(tick, intervalMs)

    const onVisibilityChange = () => {
      if (!document.hidden) tick()
    }
    document.addEventListener("visibilitychange", onVisibilityChange)

    return () => {
      cancelled = true
      globalThis.clearInterval(id)
      document.removeEventListener("visibilitychange", onVisibilityChange)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [intervalMs, ...deps])
}

export interface UseAsyncDataResult<T> {
  data: T | undefined
  error: Error | undefined
  loading: boolean
  reload: () => void
  /**
   * Reload without toggling `loading`. For background polling that shouldn't
   * flash the refresh spinner on a calm surface.
   */
  reloadSilently: () => void
}

export function useAsyncData<T>(
  loader: () => Promise<T>,
  deps: ReadonlyArray<unknown>,
): UseAsyncDataResult<T> {
  const [data, setData] = useState<T>()
  const [error, setError] = useState<Error>()
  const [loading, setLoading] = useState(true)
  const loaderRef = useRef(loader)
  loaderRef.current = loader
  const [reloadToken, setReloadToken] = useState(0)
  const silentRef = useRef(false)

  useEffect(() => {
    let cancelled = false
    if (silentRef.current) {
      silentRef.current = false
    } else {
      setLoading(true)
    }

    loaderRef
      .current()
      .then((result) => {
        if (cancelled) return
        setData(result)
        setError(undefined)
      })
      .catch((caught: unknown) => {
        if (cancelled) return
        setError(caught instanceof Error ? caught : new Error(String(caught)))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reloadToken, ...deps])

  const reload = useCallback(() => setReloadToken((token) => token + 1), [])
  const reloadSilently = useCallback(() => {
    silentRef.current = true
    setReloadToken((token) => token + 1)
  }, [])

  return { data, error, loading, reload, reloadSilently }
}
