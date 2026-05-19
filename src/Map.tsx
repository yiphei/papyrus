import { useEffect, useMemo, useRef, useState } from 'react'
import MapGL, {
  Layer,
  Popup,
  Source,
  type MapMouseEvent,
  type MapRef,
} from 'react-map-gl/mapbox'
import { useEvents } from './useEvents'
import { ensureAssetIcon, ensureEmojiIcon } from './iconLoader'
import type { EventCategory, LiveEvent } from './api'

const SF_BBOX: [number, number, number, number] = [37.7, -122.52, 37.83, -122.36]
const EVENTS_LAYER_ID = 'events-layer'

const CATEGORY_EMOJI: Record<EventCategory, string> = {
  concert: '🎵',
  sports: '🏟️',
  theater: '🎭',
  comedy: '🎤',
  film: '🎬',
  farmers_market: '🥕',
  festival: '🎉',
  fair: '🎡',
  exhibition: '🖼️',
  political: '🏛️',
  community: '🤝',
  ugc: '📍',
  other: '📌',
}

function iconIdFor(ev: LiveEvent): string {
  return ev.image_url ? `event-asset-${ev.id}` : `event-emoji-${ev.category}`
}

export default function MapView() {
  const params = useMemo(() => {
    const now = new Date()
    now.setSeconds(0, 0)
    const in2Days = new Date(now.getTime() + 2 * 24 * 60 * 60 * 1000)
    return {
      bbox: SF_BBOX,
      near: 'San Francisco',
      startsAfter: now,
      startsBefore: in2Days,
      limit: 15,
    }
  }, [])

  const { events, loading, error } = useEvents(params)
  const [selected, setSelected] = useState<LiveEvent | null>(null)
  const [iconsReady, setIconsReady] = useState(false)
  const [mapLoaded, setMapLoaded] = useState(false)
  const mapRef = useRef<MapRef>(null)

  const geojson = useMemo(
    () => ({
      type: 'FeatureCollection' as const,
      features: events.map((ev) => ({
        type: 'Feature' as const,
        geometry: { type: 'Point' as const, coordinates: [ev.lng, ev.lat] },
        properties: { id: ev.id, iconId: iconIdFor(ev) },
      })),
    }),
    [events],
  )

  useEffect(() => {
    if (!mapLoaded) return
    const map = mapRef.current?.getMap()
    if (!map || events.length === 0) return
    let cancelled = false

    setIconsReady(false)
    Promise.all(
      events.map(async (ev) => {
        const id = iconIdFor(ev)
        if (map.hasImage(id)) return
        if (ev.image_url) await ensureAssetIcon(map, id, ev.image_url)
        else ensureEmojiIcon(map, id, CATEGORY_EMOJI[ev.category])
      }),
    )
      .then(() => {
        if (!cancelled) setIconsReady(true)
      })
      .catch((e) => console.error('Failed to load event icons', e))

    return () => {
      cancelled = true
    }
  }, [mapLoaded, events])

  const handleClick = (e: MapMouseEvent) => {
    const feature = e.features?.[0]
    if (!feature) {
      setSelected(null)
      return
    }
    const id = String(feature.properties?.id ?? '')
    setSelected(events.find((x) => x.id === id) ?? null)
  }

  const setCursor = (val: string) => {
    const c = mapRef.current?.getMap().getCanvas()
    if (c) c.style.cursor = val
  }

  return (
    <div style={{ position: 'relative' }}>
      <MapGL
        ref={mapRef}
        mapboxAccessToken={import.meta.env.VITE_MAPBOX_TOKEN}
        initialViewState={{
          longitude: -122.4376,
          latitude: 37.7577,
          zoom: 12,
        }}
        style={{ width: '100vw', height: '100vh' }}
        mapStyle="mapbox://styles/mapbox/streets-v12"
        interactiveLayerIds={[EVENTS_LAYER_ID]}
        onLoad={() => setMapLoaded(true)}
        onClick={handleClick}
        onMouseEnter={() => setCursor('pointer')}
        onMouseLeave={() => setCursor('')}
      >
        {iconsReady && (
          <Source id="events" type="geojson" data={geojson}>
            <Layer
              id={EVENTS_LAYER_ID}
              type="symbol"
              layout={{
                'icon-image': ['get', 'iconId'],
                'icon-size': [
                  'interpolate',
                  ['linear'],
                  ['zoom'],
                  10, 0.6,
                  12, 1.0,
                  15, 1.2,
                ],
                'icon-anchor': 'bottom',
                'icon-allow-overlap': true,
                'icon-ignore-placement': true,
              }}
            />
          </Source>
        )}

        {selected && (
          <Popup
            longitude={selected.lng}
            latitude={selected.lat}
            anchor="top"
            onClose={() => setSelected(null)}
            closeOnClick={false}
            maxWidth="300px"
          >
            <EventPopupBody ev={selected} />
          </Popup>
        )}
      </MapGL>

      <StatusBadge loading={loading} error={error} count={events.length} />
    </div>
  )
}

function EventPopupBody({ ev }: { ev: LiveEvent }) {
  const when = ev.starts_at
    ? new Date(ev.starts_at).toLocaleString(undefined, {
        weekday: 'short',
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      })
    : null
  return (
    <div className="event-popup">
      <h3>{ev.title}</h3>
      {when && <p className="meta">{when}</p>}
      {ev.venue_name && <p className="meta">{ev.venue_name}</p>}
      {ev.address && <p className="meta">{ev.address}</p>}
      {ev.description && <p>{ev.description}</p>}
      {ev.url && (
        <p>
          <a href={ev.url} target="_blank" rel="noreferrer">
            More info ↗
          </a>
        </p>
      )}
    </div>
  )
}

function StatusBadge({
  loading,
  error,
  count,
}: {
  loading: boolean
  error: string | null
  count: number
}) {
  let text = ''
  if (loading) text = 'Loading events…'
  else if (error) text = `Error: ${error}`
  else text = `${count} event${count === 1 ? '' : 's'}`
  return <div className="status-badge">{text}</div>
}
