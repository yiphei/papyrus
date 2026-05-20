// Pin thinning via Poisson-disk sampling in pixel space.
//
// The visible pin set is computed once per zoom change: events are ranked by
// salience (category/source priority, then imminence, then a stable hash),
// then walked in order. Each candidate is accepted iff its projected pixel
// position is at least MIN_PIXEL_SEPARATION away from every already-accepted
// pin; otherwise it is absorbed into the nearest accepted pin's count.
//
// Because the walk order is independent of zoom, the set at zoom Z+1 is
// always a superset of the set at zoom Z — pins never disappear as the user
// zooms in.

import type { EventCategory, LiveEvent } from './api'

export const MIN_PIXEL_SEPARATION = 20

// Salience tiers. Lower number = higher priority.
// concert/comedy and any partiful event surface first; tech meetups (which
// dominate the Luma feed) are deprioritized so they only fill space left
// by everything else. Real `community` events are rare and worth surfacing
// at the middle tier alongside theater/film/etc.
const HIGH_CATEGORIES: ReadonlySet<EventCategory> = new Set(['concert', 'comedy'])
const LOW_CATEGORIES: ReadonlySet<EventCategory> = new Set(['tech', 'ugc', 'other'])

function priorityTier(ev: LiveEvent): number {
  if (ev.source_id === 'partiful') return 0
  if (HIGH_CATEGORIES.has(ev.category)) return 0
  if (LOW_CATEGORIES.has(ev.category)) return 2
  return 1
}

// FNV-1a 32-bit hash on the event id — deterministic tie-breaker so the
// visible set is stable across reloads without depending on input order.
function stableHash(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h >>> 0
}

export function rankEvents(events: readonly LiveEvent[]): LiveEvent[] {
  return events.slice().sort((a, b) => {
    const ta = priorityTier(a)
    const tb = priorityTier(b)
    if (ta !== tb) return ta - tb
    // Sooner starts_at wins. Events with no time sink to the bottom of the tier.
    const sa = a.starts_at ? Date.parse(a.starts_at) : Number.POSITIVE_INFINITY
    const sb = b.starts_at ? Date.parse(b.starts_at) : Number.POSITIVE_INFINITY
    if (sa !== sb) return sa - sb
    return stableHash(a.id) - stableHash(b.id)
  })
}

// Web Mercator world-pixel projection (256-px tiles). Only relative distances
// between projected points are used, so the choice of origin is irrelevant.
function lngLatToPx(lng: number, lat: number, zoom: number): [number, number] {
  const scale = 256 * Math.pow(2, zoom)
  const x = scale * (lng + 180) / 360
  const latRad = (lat * Math.PI) / 180
  const y = scale * (1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2
  return [x, y]
}

export interface ThinnedPin {
  event: LiveEvent
  // Total number of source events represented by this pin (1 if it stands
  // alone; >1 when lower-ranked pins were absorbed because they would
  // visually collide with this one at the current zoom).
  count: number
}

// Greedy O(N²) Poisson-disk filter. N ≤ ~200 so a quadtree is unnecessary.
export function thinByPixelSeparation(
  ranked: readonly LiveEvent[],
  zoom: number,
  minPx: number = MIN_PIXEL_SEPARATION,
): ThinnedPin[] {
  const accepted: { pin: ThinnedPin; x: number; y: number }[] = []
  const minSq = minPx * minPx
  for (const ev of ranked) {
    const [x, y] = lngLatToPx(ev.lng, ev.lat, zoom)
    let nearestIdx = -1
    let nearestDsq = Number.POSITIVE_INFINITY
    for (let i = 0; i < accepted.length; i++) {
      const dx = x - accepted[i].x
      const dy = y - accepted[i].y
      const dsq = dx * dx + dy * dy
      if (dsq < nearestDsq) {
        nearestDsq = dsq
        nearestIdx = i
      }
    }
    if (nearestIdx === -1 || nearestDsq >= minSq) {
      accepted.push({ pin: { event: ev, count: 1 }, x, y })
    } else {
      accepted[nearestIdx].pin.count += 1
    }
  }
  return accepted.map((a) => a.pin)
}
