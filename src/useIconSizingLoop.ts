import { useEffect, useMemo, useRef } from 'react'
import type { GeoJSONSource, Map as MapboxMap } from 'mapbox-gl'
import { computeSizes } from './iconSizing'
import type { ThinnedPin } from './thinning'
import type { LiveEvent } from './api'

export const EVENTS_SOURCE_ID = 'events'

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
export type PinFC = { type: 'FeatureCollection'; features: PinFeature[] }

function buildFC(
  thinned: readonly ThinnedPin[],
  iconIdFor: (ev: LiveEvent) => string,
): PinFC {
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

// Mutates `fc` in place with the current frame's iconSize + offsetY and
// pushes via setData. setData is the only way to drive a symbol layer's
// icon-size — it's a layout property and can't read feature-state — so we
// can't avoid this imperative path. Going directly to the source (instead
// of through React state) is what eliminates the per-frame flicker.
function writeSizes(
  map: MapboxMap,
  thinned: readonly ThinnedPin[],
  fc: PinFC,
): void {
  const source = map.getSource(EVENTS_SOURCE_ID) as GeoJSONSource | undefined
  // Source may not be attached on the first frame after a thinning change.
  // Skip until it's there; the next rAF tick will pick it up.
  if (!source) return
  const canvas = map.getCanvas()
  const vw = canvas.clientWidth
  const vh = canvas.clientHeight
  const project = (lng: number, lat: number) => {
    const p = map.project([lng, lat])
    return { x: p.x, y: p.y }
  }
  const { iconSize, offsetY } = computeSizes(thinned, project, vw, vh)
  for (let i = 0; i < thinned.length; i++) {
    const props = fc.features[i].properties
    props.iconSize = iconSize[i]
    props.offset[1] = offsetY[i]
  }
  source.setData(fc)
}

// Owns the per-pin sizing for a Mapbox symbol layer. Returns the GeoJSON
// FeatureCollection that the parent passes into <Source data={...}>.
//
// While enabled, an rAF loop runs during pan/zoom gestures and mutates the
// FC's feature properties (iconSize, offset) in place, then pushes the
// mutated FC via setData each frame. The set of pins is stable across the
// gesture — only sizes change. See docs/icon-magnification.md and
// computeSizes() in iconSizing.ts for the sizing algorithm.
export function useIconSizingLoop({
  map,
  thinned,
  enabled,
  iconIdFor,
}: {
  map: MapboxMap | null
  thinned: readonly ThinnedPin[]
  enabled: boolean
  iconIdFor: (ev: LiveEvent) => string
}): { geojson: PinFC } {
  // The same FC reference is handed to React-map-gl's <Source> and mutated
  // in place by the rAF loop. It rebuilds only when `thinned` changes, so
  // React-map-gl's own setData call (triggered by a new data prop) and our
  // imperative setData calls always operate on the same object — no clobber.
  const geojson = useMemo(
    () => buildFC(thinned, iconIdFor),
    [thinned, iconIdFor],
  )
  const fcRef = useRef<PinFC>(geojson)
  useEffect(() => {
    fcRef.current = geojson
  }, [geojson])

  useEffect(() => {
    if (!enabled || !map || thinned.length === 0) return
    const fc = fcRef.current

    let rafId = 0
    const tick = () => {
      writeSizes(map, thinned, fc)
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
      writeSizes(map, thinned, fc)
    }
    const onResize = () => writeSizes(map, thinned, fc)

    writeSizes(map, thinned, fc)
    map.on('movestart', startLoop)
    map.on('moveend', stopLoop)
    map.on('resize', onResize)
    return () => {
      if (rafId !== 0) cancelAnimationFrame(rafId)
      map.off('movestart', startLoop)
      map.off('moveend', stopLoop)
      map.off('resize', onResize)
    }
  }, [map, enabled, thinned])

  return { geojson }
}
