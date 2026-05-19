import staticData from './events.static.json'
import midweekMelodiesAsset from './assets/midweek-melodies.png'
import songsFromASinkingShipAsset from './assets/songs-from-a-sinking-ship.png'
import type { LiveEvent } from './api'

interface StaticEventInput {
  lng: number
  lat: number
  title: string
  description: string
}

const TITLE_TO_ASSET: Record<string, string> = {
  "'Midweek Melodies' Free Happy Hour Concert": midweekMelodiesAsset,
  "Songs from a Sinking Ship": songsFromASinkingShipAsset,
}

export const STATIC_EVENTS: LiveEvent[] = (staticData as StaticEventInput[]).map(
  (ev, i): LiveEvent => ({
    id: `static-${i}`,
    source_id: 'static',
    source_event_id: `static-${i}`,
    title: ev.title,
    description: ev.description,
    category: 'concert',
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
    image_url: TITLE_TO_ASSET[ev.title] ?? null,
    price: null,
    status: 'scheduled',
  }),
)
