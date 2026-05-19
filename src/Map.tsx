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
import { rankEvents, thinByPixelSeparation } from './thinning'

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
      limit: 200,
    }
  }, [])

  const { events, loading, error } = useEvents(params)
  const [selected, setSelected] = useState<LiveEvent | null>(null)
  const [iconsReady, setIconsReady] = useState(false)
  const [mapLoaded, setMapLoaded] = useState(false)
  const mapRef = useRef<MapRef>(null)

  // Tracked separately from the map's own viewState so we can drive
  // zoom-keyed rendering decisions (pin thinning, clustering) without
  // controlling the map and triggering a re-render on every pan frame.
  const [zoom, setZoom] = useState(12)

  // Rank once per event fetch; re-thin per zoom change. The ranked order is
  // stable across zooms so pins only ever appear (never disappear) as the
  // user zooms in.
  const ranked = useMemo(() => rankEvents(events), [events])
  const pins = useMemo(() => thinByPixelSeparation(ranked, zoom), [ranked, zoom])

  const geojson = useMemo(
    () => ({
      type: 'FeatureCollection' as const,
      features: pins.map(({ event: ev, count }) => ({
        type: 'Feature' as const,
        geometry: { type: 'Point' as const, coordinates: [ev.lng, ev.lat] },
        properties: { id: ev.id, iconId: iconIdFor(ev), count },
      })),
    }),
    [pins],
  )

  // Register an icon per event (not per visible pin) so re-thinning at higher
  // zoom never has to wait on a fetch — the icons are already in the sprite.
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
        onMoveEnd={(e) => setZoom(e.viewState.zoom)}
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
                // Count badge rendered as same-layer text. text-halo gives the
                // blue pill effect; empty string when count == 1 suppresses it.
                'text-field': [
                  'case',
                  ['>', ['get', 'count'], 1],
                  ['to-string', ['get', 'count']],
                  '',
                ],
                'text-size': 11,
                'text-anchor': 'center',
                'text-offset': [1.9, -3.0],
                'text-allow-overlap': true,
                'text-ignore-placement': true,
                'text-font': ['Open Sans Semibold', 'Arial Unicode MS Bold'],
              }}
              paint={{
                'text-color': '#ffffff',
                'text-halo-color': '#2563eb',
                'text-halo-width': 3,
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

      <StatusBadge
        loading={loading}
        error={error}
        count={events.length}
        shown={pins.length}
        zoom={zoom}
      />
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
  shown,
  zoom,
}: {
  loading: boolean
  error: string | null
  count: number
  shown?: number
  zoom?: number
}) {
  let text = ''
  if (loading) text = 'Loading events…'
  else if (error) text = `Error: ${error}`
  else if (shown !== undefined && shown !== count)
    text = `${shown} of ${count} event${count === 1 ? '' : 's'}`
  else text = `${count} event${count === 1 ? '' : 's'}`
  if (zoom !== undefined) text += `  ·  z=${zoom.toFixed(2)}`
  return <div className="status-badge">{text}</div>
}
