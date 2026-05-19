import staticData from './events.static.json'
import type { LiveEvent } from './api'

interface StaticEventInput {
  lng: number
  lat: number
  title: string
  description: string
}

export const STATIC_EVENTS: LiveEvent[] = (staticData as StaticEventInput[]).map(
  (ev, i): LiveEvent => ({
    id: `static-${i}`,
    source_id: 'static',
    source_event_id: `static-${i}`,
    title: ev.title,
    description: ev.description,
    category: 'other',
    tags: [],
    starts_at: null,
    ends_at: null,
    timezone: null,
    lat: ev.lat,
    lng: ev.lng,
    location_precision: 'point',
    venue_name: null,
    address: null,
    url: null,
    image_url: null,
    price: null,
    status: 'scheduled',
  }),
)
