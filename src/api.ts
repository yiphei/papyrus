// Shared event types. Mirrors src/papyrus/events/models.py shapes.

export type EventCategory =
  | 'concert'
  | 'sports'
  | 'theater'
  | 'comedy'
  | 'film'
  | 'farmers_market'
  | 'festival'
  | 'fair'
  | 'exhibition'
  | 'political'
  | 'community'
  | 'tech'
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
  starts_at: string | null // ISO 8601
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
