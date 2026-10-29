import { createContext, useCallback, useContext, useEffect, useState } from 'react'
import type { User } from './types'

/** Call the API. Throws an Error whose message is the server's plain-words error. */
export async function api<T = unknown>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const init: RequestInit = { method }
  if (body instanceof FormData) init.body = body
  else if (method !== 'GET') {
    init.headers = { 'content-type': 'application/json' }
    init.body = JSON.stringify(body ?? {})
  }
  const res = await fetch(`/api${path}`, init)
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error ?? 'Something went wrong. Please try again.')
  return data as T
}

/** Load data on mount (and when `deps` change). `reload()` fetches again. */
export function useLoad<T>(load: () => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [tick, setTick] = useState(0)
  useEffect(() => {
    let cancelled = false
    load().then(
      (d) => !cancelled && (setData(d), setError(null)),
      (e: Error) => !cancelled && setError(e.message),
    )
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick])
  const reload = useCallback(() => setTick((t) => t + 1), [])
  return { data, error, reload }
}

interface MeState {
  user: User | null
  loading: boolean
  refresh: () => void
}
export const MeContext = createContext<MeState>({ user: null, loading: true, refresh: () => {} })
export const useMe = () => useContext(MeContext)
