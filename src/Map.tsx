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
import { useIconSizingLoop, EVENTS_SOURCE_ID } from './useIconSizingLoop'

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

// Display order for the filter bar. Categories with zero events are
// hidden, so this list can stay long without crowding.
const CATEGORY_ORDER: EventCategory[] = [
  'concert', 'sports', 'theater', 'comedy', 'film',
  'farmers_market', 'festival', 'fair', 'exhibition',
  'political', 'community', 'tech', 'ugc', 'other',
]

function iconIdFor(ev: LiveEvent): string {
  return ev.image_url ? `event-asset-${ev.id}` : `event-emoji-${ev.category}`
}

export default function MapView() {
  const { events, loading, error } = useEvents()
  const [selected, setSelected] = useState<LiveEvent | null>(null)
  const [iconsReady, setIconsReady] = useState(false)
  const [mapLoaded, setMapLoaded] = useState(false)
  const mapRef = useRef<MapRef>(null)

  // settledZoom advances only at moveEnd and drives thinning, so the visible
  // pin set stays stable mid-gesture (no pop-in/out during zoom). Per-pin
  // sizing during a gesture lives in useIconSizingLoop — it runs an
  // imperative rAF loop that pushes per-frame iconSize + icon-offset to
  // Mapbox via setData, so React doesn't see per-frame size updates.
  const [settledZoom, setSettledZoom] = useState(12)
  // null = "all on"; a Set = explicit allowlist.
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
  const map = mapLoaded ? (mapRef.current?.getMap() ?? null) : null
  const { geojson } = useIconSizingLoop({
    map,
    thinned,
    enabled: mapLoaded && iconsReady,
    iconIdFor,
  })

  // Register an icon per event (not per visible pin) so re-thinning at higher
  // zoom finds the icon already in the sprite, with no mid-gesture pop-in.
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
        onMoveEnd={(e) => setSettledZoom(e.viewState.zoom)}
        onClick={handleClick}
        onMouseEnter={() => setCursor('pointer')}
        onMouseLeave={() => setCursor('')}
      >
        {iconsReady && (
          <Source id={EVENTS_SOURCE_ID} type="geojson" data={geojson}>
            <Layer
              id={EVENTS_LAYER_ID}
              type="symbol"
              layout={{
                'icon-image': ['get', 'iconId'],
                // iconSize and offset are mutated per frame by useIconSizingLoop
                // and pushed via source.setData(). icon-size is a layout
                // property and can't read feature-state, so plain ['get', ...]
                // is required.
                'icon-size': ['get', 'iconSize'],
                'icon-offset': ['get', 'offset'],
                'icon-anchor': 'bottom',
                'icon-allow-overlap': true,
                'icon-ignore-placement': true,
                // Larger icons render on top. The overlap solver in
                // iconSizing.ts uses an inscribed-disk model (radius = half
                // the icon's height), so square corners can still cross
                // between neighbors. When that happens, the dominant icon
                // (highest iconSize) should stay unoccluded by smaller
                // ones. With icon-allow-overlap=true, a higher sort-key
                // renders on top; per-frame iconSize updates re-evaluate it.
                'symbol-sort-key': ['get', 'iconSize'],
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
        shown={thinned.length}
        zoom={settledZoom}
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
