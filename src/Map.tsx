import { useEffect, useMemo, useRef, useState } from 'react'
import MapGL, {
  Layer,
  Popup,
  Source,
  type MapMouseEvent,
  type MapRef,
} from 'react-map-gl/mapbox'
import { useEvents } from './useEvents'
import { ensureEmojiIcon } from './iconLoader'
import type { EventCategory, LiveEvent } from './api'
import { rankEvents, sizeByNearestNeighbor, thinByPixelSeparation } from './thinning'

const SF_BBOX: [number, number, number, number] = [37.7, -122.52, 37.83, -122.36]
const EVENTS_LAYER_ID = 'events-layer'

// CSS-pixel size of the emoji icon bitmap at icon-size=1. Drives the
// nearest-neighbor sizing math so iconSize multipliers translate into
// real on-screen pixels.
const EMOJI_ICON_PX = 36
// Floor: icons never render smaller than this multiple of native size, so
// dense clusters stay readable instead of collapsing to a dot.
const EMOJI_MIN_ICON_SIZE = 1.0
// Ceiling: lone pins at deep zoom don't blow past this multiple of native.
const EMOJI_MAX_ICON_SIZE = 1.5

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
  tech: '💻',
  ugc: '📍',
  other: '📌',
}

const CATEGORY_LABEL: Record<EventCategory, string> = {
  concert: 'Concerts',
  sports: 'Sports',
  theater: 'Theater',
  comedy: 'Comedy',
  film: 'Film',
  farmers_market: 'Markets',
  festival: 'Festivals',
  fair: 'Fairs',
  exhibition: 'Exhibitions',
  political: 'Political',
  community: 'Community',
  tech: 'Tech',
  ugc: 'User',
  other: 'Other',
}

// Display order for the filter bar. Categories with zero events in the
// current fetch are hidden, so this list can stay long without crowding.
const CATEGORY_ORDER: EventCategory[] = [
  'concert', 'sports', 'theater', 'comedy', 'film',
  'farmers_market', 'festival', 'fair', 'exhibition',
  'political', 'community', 'tech', 'ugc', 'other',
]

function iconIdFor(ev: LiveEvent): string {
  return `event-emoji-${ev.category}`
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

  // Two zoom signals on purpose:
  //   - settledZoom advances only at moveEnd and drives thinning, so the
  //     visible pin set stays stable mid-gesture (no pop-in/out during zoom).
  //   - zoom advances on every move frame and drives per-pin sizing, so
  //     icons scale continuously with the gesture rather than snapping at
  //     moveEnd. Pan frames are filtered out by React's setState bail-out
  //     (the zoom value is identical, so no re-render).
  const [zoom, setZoom] = useState(12)
  const [settledZoom, setSettledZoom] = useState(12)
  // Setters retained for the move/resize listeners; values currently unused
  // while the per-pin position cap and proximity magnification are disabled.
  const [, setMoveTick] = useState(0)
  const [, setViewportTick] = useState(0)
  // null = "all on"; a Set = explicit allowlist. Filtering is client-side
  // because the backend caches the full inventory and toggling on the
  // server would force a refetch on every click.
  const [activeCats, setActiveCats] = useState<Set<EventCategory> | null>(null)

  const countsByCategory = useMemo(() => {
    const m = new Map<EventCategory, number>()
    for (const ev of events) m.set(ev.category, (m.get(ev.category) ?? 0) + 1)
    return m
  }, [events])

  const visibleEvents = useMemo(() => {
    if (activeCats === null) return events
    return events.filter((ev) => activeCats.has(ev.category))
  }, [events, activeCats])

  const ranked = useMemo(() => rankEvents(visibleEvents), [visibleEvents])
  const thinned = useMemo(
    () => thinByPixelSeparation(ranked, settledZoom),
    [ranked, settledZoom],
  )
  // Sizing: each pin grows to fill the gap to its nearest neighbor.
  // iconNativePx must match the emoji-icon canvas (36 css px) — the default
  // 110 was calibrated for the now-removed asset icons and shrank emoji
  // pins to ~6 css px even at the minSize floor.
  const pins = useMemo(() => {
    return sizeByNearestNeighbor(thinned, zoom, {
      iconNativePx: EMOJI_ICON_PX,
      minSize: EMOJI_MIN_ICON_SIZE,
      maxSize: EMOJI_MAX_ICON_SIZE,
    })
  }, [thinned, zoom])

  const geojson = useMemo(
    () => ({
      type: 'FeatureCollection' as const,
      features: pins.map(({ event: ev, count, iconSize }) => ({
        type: 'Feature' as const,
        geometry: { type: 'Point' as const, coordinates: [ev.lng, ev.lat] },
        properties: { id: ev.id, iconId: iconIdFor(ev), count, iconSize },
      })),
    }),
    [pins],
  )

  useEffect(() => {
    if (!mapLoaded) return
    const map = mapRef.current?.getMap()
    if (!map) return
    const bump = () => setViewportTick((t) => t + 1)
    map.on('resize', bump)
    return () => {
      map.off('resize', bump)
    }
  }, [mapLoaded])

  // Register every category's emoji bitmap once at map-load time. Doing this
  // up-front (rather than per-event after fetch) closes a render-order race:
  // the symbol layer's geojson recomputes synchronously during render with
  // iconIds for the new events, but a per-event useEffect only runs after
  // paint, so mapbox would log "Image ... could not be loaded" and silently
  // drop those pins. With 14 categories the upfront cost is trivial.
  // A `styleimagemissing` handler is kept as a fallback for any iconId that
  // ever slips through (e.g. a future non-category icon scheme).
  useEffect(() => {
    if (!mapLoaded) return
    const map = mapRef.current?.getMap()
    if (!map) return

    for (const cat of CATEGORY_ORDER) {
      const id = `event-emoji-${cat}`
      if (!map.hasImage(id)) ensureEmojiIcon(map, id, CATEGORY_EMOJI[cat])
    }
    setIconsReady(true)

    const onMissing = (e: { id: string }) => {
      const id = e.id
      if (map.hasImage(id)) return
      const match = /^event-emoji-(.+)$/.exec(id)
      if (!match) return
      const cat = match[1] as EventCategory
      const emoji = CATEGORY_EMOJI[cat]
      if (emoji) ensureEmojiIcon(map, id, emoji)
    }
    map.on('styleimagemissing', onMissing)
    return () => {
      map.off('styleimagemissing', onMissing)
    }
  }, [mapLoaded])

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

  function toggleCategory(cat: EventCategory) {
    setActiveCats((prev) => {
      // First click on any chip: snapshot the current "all enabled" set
      // and remove just the clicked one.
      const all = new Set<EventCategory>(countsByCategory.keys())
      const base = prev ?? all
      const next = new Set(base)
      if (next.has(cat)) next.delete(cat)
      else next.add(cat)
      // Collapse back to null when every available category is on, so the
      // visual state matches "no filter active".
      if (next.size === all.size) return null
      return next
    })
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
        onMove={(e) => {
          setZoom(e.viewState.zoom)
          setMoveTick((t) => t + 1)
        }}
        onMoveEnd={(e) => setSettledZoom(e.viewState.zoom)}
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
                // Per-pin iconSize is recomputed in source data on every
                // move frame (see useMemo on `pins` keyed to `zoom`), so a
                // plain data expression already animates smoothly with the
                // gesture. A zoom expression here would actually be worse —
                // symbol layers cache the layout-time evaluation of
                // data-driven sizes and only update on source data change,
                // so a ['zoom']-driven scale factor wouldn't re-evaluate
                // per frame anyway.
                'icon-size': ['get', 'iconSize'],
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

      <CategoryFilter
        counts={countsByCategory}
        active={activeCats}
        onToggle={toggleCategory}
        onReset={() => setActiveCats(null)}
      />
    </div>
  )
}

function CategoryFilter({
  counts,
  active,
  onToggle,
  onReset,
}: {
  counts: Map<EventCategory, number>
  active: Set<EventCategory> | null
  onToggle: (cat: EventCategory) => void
  onReset: () => void
}) {
  const present = CATEGORY_ORDER.filter((c) => (counts.get(c) ?? 0) > 0)
  if (present.length === 0) return null
  const filtering = active !== null
  return (
    <div className="category-filter" role="group" aria-label="Filter by category">
      {present.map((cat) => {
        const on = active === null || active.has(cat)
        return (
          <button
            key={cat}
            type="button"
            className={`cat-chip${on ? '' : ' off'}`}
            onClick={() => onToggle(cat)}
            aria-pressed={on}
          >
            <span className="cat-chip-emoji">{CATEGORY_EMOJI[cat]}</span>
            <span className="cat-chip-label">{CATEGORY_LABEL[cat]}</span>
            <span className="cat-chip-count">{counts.get(cat)}</span>
          </button>
        )
      })}
      {filtering && (
        <button type="button" className="cat-chip reset" onClick={onReset}>
          Reset
        </button>
      )}
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
