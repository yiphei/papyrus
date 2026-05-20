import { useEffect, useMemo, useRef, useState } from 'react'
import MapGL, {
  Layer,
  Popup,
  Source,
  type MapMouseEvent,
  type MapRef,
} from 'react-map-gl/mapbox'
import type { Map as MapboxMap } from 'mapbox-gl'
import { useEvents } from './useEvents'
import { ensureAssetIcon, ensureEmojiIcon } from './iconLoader'
import type { EventCategory, LiveEvent } from './api'
import { rankEvents, thinByPixelSeparation, type ThinnedPin } from './thinning'
import { computeSizes, ICON_NATIVE_PX } from './iconSizing'

const EVENTS_LAYER_ID = 'events-layer'
const EVENTS_SOURCE_ID = 'events'

// Radius of the "centered" hit region around the screen center, as a
// fraction of the smaller viewport dimension. Generous on purpose: the
// user shouldn't need to land a pin precisely at (cx, cy) — they just
// need to roughly center it.
const CENTER_PROXIMITY = 0.12

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

// One mutable GeoJSON FeatureCollection per source mount. The rAF loop mutates
// per-pin `iconSize` and `offset` in place and pushes via setData each frame,
// avoiding per-frame allocation churn. The FC is rebuilt only when the thinned
// set changes (see useEffect that resets `fcRef.current`).
type FeatureProps = {
  id: string
  iconId: string
  count: number
  iconSize: number
  offset: [number, number]
}
type PinFeature = {
  type: 'Feature'
  id: number
  geometry: { type: 'Point'; coordinates: [number, number] }
  properties: FeatureProps
}
type PinFC = { type: 'FeatureCollection'; features: PinFeature[] }

function buildFC(thinned: readonly ThinnedPin[]): PinFC {
  return {
    type: 'FeatureCollection',
    features: thinned.map((pin, i) => ({
      type: 'Feature',
      id: i,
      geometry: { type: 'Point', coordinates: [pin.event.lng, pin.event.lat] },
      properties: {
        id: pin.event.id,
        iconId: iconIdFor(pin.event),
        count: pin.count,
        iconSize: 0,
        offset: [0, 0],
      },
    })),
  }
}

// Computes per-pin iconSize/offsetY for the current camera, mutates the
// FeatureCollection in place, and pushes it to the source via setData.
// Mapbox's symbol layer reads `iconSize` and `offset` from feature
// properties via plain `['get', ...]` expressions. We call setData
// imperatively (not via React state) so per-frame size updates don't go
// through React's render cycle — that path was the original flicker source.
//
// Returns the event whose icon visual-center is closest to (cx, cy) within
// CENTER_PROXIMITY × min(vw, vh), or null. Detection runs here (not as a
// useMemo) because per-pin geometry is now mutated imperatively and React
// no longer sees per-frame updates.
function writeSizes(
  map: MapboxMap,
  thinned: readonly ThinnedPin[],
  fc: PinFC,
): LiveEvent | null {
  const source = map.getSource(EVENTS_SOURCE_ID)
  // Source may not be attached on the first frame after a thinning change.
  // Skip until it's there; the rAF loop / sourcedata event will pick it up.
  if (!source) return null
  const canvas = map.getCanvas()
  const vw = canvas.clientWidth
  const vh = canvas.clientHeight
  const project = (lng: number, lat: number) => {
    const p = map.project([lng, lat])
    return { x: p.x, y: p.y }
  }
  const { iconSize, offsetY } = computeSizes(thinned, project, vw, vh)
  const cx = vw / 2
  const cy = vh / 2
  const threshold = Math.min(vw, vh) * CENTER_PROXIMITY
  let centered: LiveEvent | null = null
  let bestDist = threshold
  for (let i = 0; i < thinned.length; i++) {
    const props = fc.features[i].properties
    props.iconSize = iconSize[i]
    props.offset[1] = offsetY[i]
    // Visual center of the rendered icon. icon-anchor='bottom' puts the
    // sprite's bottom at the projected lng/lat; icon-offset (in icon-canvas
    // px, multiplied by iconSize at render time) shifts it back down so a
    // large icon ends up center-anchored at the coord. For a small icon
    // (offsetY ≈ 0) the visual center sits half an icon-height above the
    // tip; for a large one (offsetY ≈ ICON_NATIVE_PX/2) it lands on the tip.
    const { x, y } = project(thinned[i].event.lng, thinned[i].event.lat)
    const visualY = y + (offsetY[i] - ICON_NATIVE_PX / 2) * iconSize[i]
    const dist = Math.hypot(x - cx, visualY - cy)
    if (dist < bestDist) {
      bestDist = dist
      centered = thinned[i].event
    }
  }
  // setData reparses the FC each call; for ~200 features this is well under
  // a millisecond. mapbox-gl-js GeoJSONSource exposes setData via the
  // returned Source instance.
  ;(source as { setData(data: PinFC): void }).setData(fc)
  return centered
}

export default function MapView() {
  const { events, loading, error } = useEvents()
  const [selected, setSelected] = useState<LiveEvent | null>(null)
  const [iconsReady, setIconsReady] = useState(false)
  const [mapLoaded, setMapLoaded] = useState(false)
  const mapRef = useRef<MapRef>(null)

  // settledZoom advances only at moveEnd and drives thinning, so the visible
  // pin set stays stable mid-gesture (no pop-in/out during zoom). Per-pin
  // sizing during a gesture is driven by an imperative rAF loop that writes
  // map.setFeatureState — see the rAF useEffect below — so React no longer
  // tracks zoom on the per-frame path. The `zoom` state below is only for
  // the status badge and updates on moveEnd.
  const [zoom, setZoom] = useState(12)
  const [settledZoom, setSettledZoom] = useState(12)
  // null = "all on"; a Set = explicit allowlist.
  const [activeCats, setActiveCats] = useState<Set<EventCategory> | null>(null)
  // The event whose icon is currently near the screen center. Populated by
  // the imperative rAF loop below (writeSizes computes it alongside sizing),
  // and only changes when the *identity* of the centered event changes, so
  // re-renders are kept to actual transitions, not every frame.
  const [centeredEvent, setCenteredEvent] = useState<LiveEvent | null>(null)

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
  // The React-controlled GeoJSON source is built once per thinning change
  // with placeholder iconSize=0/offset=[0,0]. After mount, an imperative rAF
  // loop owns the source — it mutates the same FC and calls setData() each
  // frame to push fresh sizes. React-map-gl only pushes through setData when
  // the data prop reference changes (i.e. when `thinned` changes), so our
  // imperative writes are never clobbered mid-gesture.
  const fcRef = useRef<PinFC | null>(null)
  const geojson = useMemo(() => {
    const fc = buildFC(thinned)
    fcRef.current = fc
    return fc
  }, [thinned])

  // Imperative rAF loop: computes per-pin iconSize + offsetY each frame during
  // a gesture and mutates the FC, then pushes via setData. setData is the only
  // way to update icon-size on a symbol layer (it's a layout property, so
  // feature-state can't drive it). Calling setData directly from rAF avoids
  // routing per-frame work through React's reconciliation, which was the
  // original flicker source.
  useEffect(() => {
    if (!mapLoaded || !iconsReady) return
    const map = mapRef.current?.getMap()
    if (!map) return
    if (thinned.length === 0) return
    const fc = fcRef.current
    if (!fc) return

    // writeSizes returns the currently-centered event each frame; only
    // commit it to React state when the identity actually changes, so this
    // doesn't re-render 60×/sec during a gesture.
    const updateCentered = (next: LiveEvent | null) => {
      setCenteredEvent((prev) => (prev?.id === next?.id ? prev : next))
    }

    let rafId = 0
    const tick = () => {
      updateCentered(writeSizes(map, thinned, fc))
      rafId = requestAnimationFrame(tick)
    }
    const startLoop = () => {
      if (rafId === 0) rafId = requestAnimationFrame(tick)
    }
    const stopLoop = () => {
      if (rafId !== 0) {
        cancelAnimationFrame(rafId)
        rafId = 0
      }
      updateCentered(writeSizes(map, thinned, fc))
    }
    const onResize = () => updateCentered(writeSizes(map, thinned, fc))

    updateCentered(writeSizes(map, thinned, fc))
    map.on('movestart', startLoop)
    map.on('moveend', stopLoop)
    map.on('resize', onResize)
    return () => {
      if (rafId !== 0) cancelAnimationFrame(rafId)
      map.off('movestart', startLoop)
      map.off('moveend', stopLoop)
      map.off('resize', onResize)
    }
  }, [mapLoaded, iconsReady, thinned])

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
        onMoveEnd={(e) => {
          setZoom(e.viewState.zoom)
          setSettledZoom(e.viewState.zoom)
        }}
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
                // iconSize and offset are mutated per frame in fcRef.current's
                // feature properties and pushed via source.setData() from the
                // rAF loop. icon-size is a layout property and can't read
                // feature-state, so plain ['get', ...] is required here.
                'icon-size': ['get', 'iconSize'],
                'icon-offset': ['get', 'offset'],
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
        shown={thinned.length}
        zoom={zoom}
      />

      <CategoryFilter
        counts={countsByCategory}
        active={activeCats}
        onToggle={toggleCategory}
        onReset={() => setActiveCats(null)}
      />

      {centeredEvent && (
        <div className="event-side-panel" role="complementary">
          <EventDetails ev={centeredEvent} />
        </div>
      )}
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

function EventDetails({ ev }: { ev: LiveEvent }) {
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
    <>
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
    </>
  )
}

function EventPopupBody({ ev }: { ev: LiveEvent }) {
  return (
    <div className="event-popup">
      <EventDetails ev={ev} />
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
