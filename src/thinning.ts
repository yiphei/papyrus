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

export interface SizedPin extends ThinnedPin {
  // Multiplier for the symbol layer's icon-size: scaled so each pin's icon
  // expands to fill the gap to its nearest neighbor without overlapping it.
  iconSize: number
}

export interface ScreenPosition {
  x: number
  y: number
  // Off-screen neighbors don't constrain a visible pin's size — a lone
  // visible pin should be able to grow to fill the viewport regardless of
  // where its off-screen kin sit.
  visible: boolean
}

// Set icon-size per pin so each icon grows to fill the gap to its nearest
// neighbor in pixel space — sparse pins get magnified, dense pins stay small.
// Approximates each icon as a circle of radius (iconNativePx/2)*iconSize at
// the pin point; two same-sized neighbors at distance D touch when iconSize
// = D/iconNativePx, so that's the cap. A lone pin (no visible neighbors)
// takes maxSize. minSize keeps icons readable in worst-case clusters at the
// cost of slight overlap when neighbors land below the floor distance.
//
// `positions` are screen pixels from map.project(), so pitch/bearing/center
// are already accounted for. positions[i] aligns with thinned[i].
export function sizeByNearestNeighbor(
  thinned: readonly ThinnedPin[],
  positions: readonly ScreenPosition[],
  opts: { iconNativePx?: number; minSize?: number; maxSize?: number } = {},
): SizedPin[] {
  const iconNativePx = opts.iconNativePx ?? 110
  const minSize = opts.minSize ?? MIN_PIXEL_SEPARATION / 110
  // Sized so a lone pin's 110-px footprint × maxSize comfortably exceeds a
  // typical viewport — the nearest-neighbor formula caps spread-out pins
  // organically, so this only kicks in for truly isolated ones.
  const maxSize = opts.maxSize ?? 15
  return thinned.map((pin, i) => {
    const p = positions[i]
    let nearestDsq = Number.POSITIVE_INFINITY
    if (p) {
      for (let j = 0; j < positions.length; j++) {
        if (j === i) continue
        const q = positions[j]
        if (!q.visible) continue
        const dx = p.x - q.x
        const dy = p.y - q.y
        const dsq = dx * dx + dy * dy
        if (dsq < nearestDsq) nearestDsq = dsq
      }
    }
    const raw = nearestDsq === Number.POSITIVE_INFINITY
      ? maxSize
      : Math.sqrt(nearestDsq) / iconNativePx
    const iconSize = Math.min(maxSize, Math.max(minSize, raw))
    return { ...pin, iconSize }
  })
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
