import { useEffect, useRef, useState } from 'react'
import type { Map as MapboxMap } from 'mapbox-gl'
import type { ThinnedPin } from './thinning'
import type { LiveEvent } from './api'

const DEFAULT_RADIUS_PX = 150

// Tracks which visible event icon (if any) is currently inside a circular
// "focus zone" around the viewport center. The pin closest to the center is
// the winner, and only if its distance is within `radiusPx`. Listens to map
// `move`/`moveend`/`resize` and only calls setState when the focused event id
// actually changes, so per-tick recomputation doesn't trigger React re-renders.
export function useFocusedEvent({
  map,
  thinned,
  enabled,
  radiusPx = DEFAULT_RADIUS_PX,
}: {
  map: MapboxMap | null
  thinned: readonly ThinnedPin[]
  enabled: boolean
  radiusPx?: number
}): { focusedEvent: LiveEvent | null } {
  const [focusedEvent, setFocusedEvent] = useState<LiveEvent | null>(null)
  const idRef = useRef<string | null>(null)

  useEffect(() => {
    if (!enabled || !map) {
      if (idRef.current !== null) {
        idRef.current = null
        setFocusedEvent(null)
      }
      return
    }

    const recompute = () => {
      const canvas = map.getCanvas()
      const cx = canvas.clientWidth / 2
      const cy = canvas.clientHeight / 2

      let bestEvent: LiveEvent | null = null
      let bestDist = Infinity
      for (const pin of thinned) {
        const p = map.project([pin.event.lng, pin.event.lat])
        const d = Math.hypot(p.x - cx, p.y - cy)
        if (d < bestDist) {
          bestDist = d
          bestEvent = pin.event
        }
      }
      const winner = bestDist <= radiusPx ? bestEvent : null
      const winnerId = winner?.id ?? null
      if (winnerId !== idRef.current) {
        idRef.current = winnerId
        setFocusedEvent(winner)
      }
    }

    recompute()
    map.on('move', recompute)
    map.on('moveend', recompute)
    map.on('resize', recompute)
    return () => {
      map.off('move', recompute)
      map.off('moveend', recompute)
      map.off('resize', recompute)
    }
  }, [map, thinned, enabled, radiusPx])

  return { focusedEvent }
}
