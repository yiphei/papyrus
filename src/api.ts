// Typed client for the Papyrus FastAPI backend.
// Mirrors src/papyrus/events/models.py shapes.

export type EventCategory =
  | 'concert'
  | 'sports'
  | 'theater'
  | 'farmers_market'
  | 'festival'
  | 'fair'
  | 'exhibition'
  | 'political'
  | 'community'
  | 'ugc'
  | 'other'

export type EventStatus = 'scheduled' | 'cancelled' | 'postponed'

export type LocationPrecision = 'point' | 'venue' | 'area' | 'region'

export interface LiveEvent {
  id: string
  source_id: string
  source_event_id: string
  title: string
  description: string | null
  category: EventCategory
  tags: string[]
  starts_at: string // ISO 8601
  ends_at: string | null
  timezone: string | null
  lat: number
  lng: number
  location_precision: LocationPrecision
  venue_name: string | null
  address: string | null
  url: string | null
  image_url: string | null
  price: string | null
  status: EventStatus
}

export interface EventsResponse {
  events: LiveEvent[]
}

export interface FetchEventsParams {
  bbox: [number, number, number, number] // south, west, north, east
  near?: string
  startsAfter?: Date
  startsBefore?: Date
  categories?: EventCategory[]
  limit?: number
  signal?: AbortSignal
}

const API_URL = import.meta.env.VITE_API_URL ?? 'http://127.0.0.1:8000'

export async function fetchEvents(params: FetchEventsParams): Promise<LiveEvent[]> {
  const qs = new URLSearchParams()
  qs.set('bbox', params.bbox.join(','))
  if (params.near) qs.set('near', params.near)
  if (params.startsAfter) qs.set('starts_after', params.startsAfter.toISOString())
  if (params.startsBefore) qs.set('starts_before', params.startsBefore.toISOString())
  if (params.categories) for (const c of params.categories) qs.append('categories', c)
  if (params.limit !== undefined) qs.set('limit', String(params.limit))

  const res = await fetch(`${API_URL}/events?${qs.toString()}`, { signal: params.signal })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`GET /events ${res.status}: ${body || res.statusText}`)
  }
  const data = (await res.json()) as EventsResponse
  return data.events
}
