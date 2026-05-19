import { useMemo, useState } from 'react'
import type { MapEvent } from 'react-map-gl/mapbox'
import Map, { Marker, Popup } from 'react-map-gl/mapbox'
import { useEvents } from './useEvents'
import type { EventCategory, LiveEvent } from './api'

const SF_BBOX: [number, number, number, number] = [37.70, -122.52, 37.83, -122.36]

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

  const handleLoad = (e: MapEvent) => {
    const map = e.target
    map.setCamera({ 'camera-projection': 'orthographic' })

    if (!map.getLayer('papyrus-3d-buildings')) {
      const labelLayerId = map
        .getStyle()
        ?.layers?.find(
          (l) => l.type === 'symbol' && (l.layout as Record<string, unknown> | undefined)?.['text-field'],
        )?.id

      map.addLayer(
        {
          id: 'papyrus-3d-buildings',
          source: 'composite',
          'source-layer': 'building',
          filter: ['==', 'extrude', 'true'],
          type: 'fill-extrusion',
          minzoom: 13,
          paint: {
            'fill-extrusion-color': '#d8d4cc',
            'fill-extrusion-height': ['get', 'height'],
            'fill-extrusion-base': ['get', 'min_height'],
            'fill-extrusion-opacity': 0.85,
          },
        },
        labelLayerId,
      )
    }
  }

  return (
    <div style={{ position: 'relative' }}>
      <Map
        mapboxAccessToken={import.meta.env.VITE_MAPBOX_TOKEN}
        initialViewState={{
          longitude: -122.4194,
          latitude: 37.7749,
          zoom: 15,
          pitch: 60,
          bearing: -30,
        }}
        style={{ width: '100vw', height: '100vh' }}
        mapStyle="mapbox://styles/mapbox/streets-v12"
        onLoad={handleLoad}
      >
        {events.map((ev) => (
          <Marker
            key={ev.id}
            longitude={ev.lng}
            latitude={ev.lat}
            anchor="bottom"
            onClick={(e) => {
              e.originalEvent.stopPropagation()
              setSelected(ev)
            }}
          >
            <div className="event-pin" title={ev.title}>
              <span>{CATEGORY_EMOJI[ev.category]}</span>
            </div>
          </Marker>
        ))}

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
      </Map>

      <StatusBadge loading={loading} error={error} count={events.length} />
    </div>
  )
}

function EventPopupBody({ ev }: { ev: LiveEvent }) {
  const when = new Date(ev.starts_at).toLocaleString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
  return (
    <div className="event-popup">
      <h3>{ev.title}</h3>
      <p className="meta">{when}</p>
      {ev.venue_name && <p className="meta">{ev.venue_name}</p>}
      {ev.address && <p className="meta">{ev.address}</p>}
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
