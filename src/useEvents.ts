import { useEffect, useState } from 'react'
import { fetchEvents, type FetchEventsParams, type LiveEvent } from './api'

export interface UseEventsState {
  events: LiveEvent[]
  loading: boolean
  error: string | null
}

// Fetches once when the stable JSON-serialized params change.
// Keep params object identity stable in callers (e.g. useMemo) to avoid refetches.
export function useEvents(params: FetchEventsParams): UseEventsState {
  const [events, setEvents] = useState<LiveEvent[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    setError(null)
    fetchEvents({ ...params, signal: controller.signal })
      .then((evts) => setEvents(evts))
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === 'AbortError') return
        setError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => setLoading(false))
    return () => controller.abort()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(serializeParams(params))])

  return { events, loading, error }
}

function serializeParams(p: FetchEventsParams) {
  return {
    bbox: p.bbox,
    near: p.near ?? null,
    startsAfter: p.startsAfter?.toISOString() ?? null,
    startsBefore: p.startsBefore?.toISOString() ?? null,
    categories: p.categories ?? null,
    limit: p.limit ?? null,
  }
}
