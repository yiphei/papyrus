// Per-pin icon sizing for the map's event symbol layer.
//
// The user-visible invariants this module enforces:
//   1. No two icons ever overlap. Pairwise allocation between any two pins
//      is the smooth blend of the two greedy orderings ("i wins the pair" vs
//      "j wins the pair"), weighted by their relative distance to screen
//      center. At the extremes the closer pin reaches its full allowance and
//      the farther pin gets the leftover; in between, both interpolate
//      continuously. The result is a single-pass, stateless, per-pin size
//      that is a continuous function of every pin's position — no winner-swap
//      jump when two pins pass through near-equal proximity during a pan.
//      See the computeSizes() comment for the formula.
//   2. Pins near the screen center magnify; pins farther away miniaturize.
//      The falloff is a smoothstep across the viewport diagonal, so tiny
//      pans don't perturb center pins.
//   3. A lone visible pin scales to fill ~ABS_MAX_FRAC of the smaller
//      viewport dimension, accomplished by ramping the y component of
//      `icon-offset` down (in screen coords) as the icon grows, which
//      visually re-anchors the artwork from 'bottom' to 'center' without
//      a discrete jump.
//
// All functions here are pure and unit-testable. The rAF loop in
// useIconSizingLoop calls computeSizes() once per frame during a gesture.

import type { ThinnedPin } from './thinning'

// Native height of an icon sprite in CSS pixels. iconLoader draws asset
// sprites at 110 px and emoji sprites at 36 px; the symbol layer's
// icon-size multiplier is applied relative to the sprite's own pixel size,
// so a single ICON_NATIVE_PX is the right unit for asset icons. Emoji
// icons render proportionally smaller, which is desirable.
export const ICON_NATIVE_PX = 110

// Proximity falloff floor: edge-of-diagonal pins shrink to this multiple
// of their otherwise-allowed size.
export const MIN_FACTOR = 0.7

// Distance-from-center normalizer = viewport diagonal × this. Bigger value
// = gentler falloff (corner pins are at t<1, so factor never hits MIN_FACTOR).
export const DENOM_FRAC = 0.6

// Lone pin's absolute size cap, as a fraction of min(vw, vh). 0.8 means a
// solo pin centered on screen fills 80% of the smaller viewport dimension.
export const ABS_MAX_FRAC = 0.8

// Below ANCHOR_RAMP_LOW the icon sits bottom-anchored (dot at the coord).
// Above ANCHOR_RAMP_HIGH the icon is fully lifted so its visual center is
// at the coord. Between the two: smoothstep.
export const ANCHOR_RAMP_LOW = 2.0
export const ANCHOR_RAMP_HIGH = 4.0

// Minimum size floor. Matches the old MIN_PIXEL_SEPARATION (20) / 110.
export const MIN_SIZE = 20 / ICON_NATIVE_PX

// Half-width (in screen pixels) of the pair-blend zone in computeSizes. For
// two pins whose distances-to-screen-center differ by less than CROSSOVER_BLEND_PX,
// the pair-allocation blends smoothly between the two greedy orderings
// ("i wins the pair" ↔ "j wins the pair"); outside the band it collapses to
// plain greedy. Larger value = wider smooth crossover, slower handoff. See
// docs/icon-magnification.md §7.
export const CROSSOVER_BLEND_PX = 80

// Radius (as a fraction of min(vw, vh)) around the viewport center that
// counts as "the icon is centered" for the on-hover description panel. Wide
// enough that the user doesn't have to land on (0,0) — small enough that
// only one pin at a time qualifies in practice.
export const CENTER_HOLD_FRAC = 0.15

function clamp01(x: number): number {
  if (x < 0) return 0
  if (x > 1) return 1
  return x
}

function smoothstep(t: number): number {
  const c = clamp01(t)
  return c * c * (3 - 2 * c)
}

// Multiplier in [MIN_FACTOR, 1] applied per pin based on screen-space
// distance to viewport center. Identity at center; MIN_FACTOR at corners.
export function proximityFactor(
  x: number,
  y: number,
  vw: number,
  vh: number,
): number {
  const cx = vw / 2
  const cy = vh / 2
  const diag = Math.hypot(vw, vh)
  const denom = diag * DENOM_FRAC
  if (denom <= 0) return 1
  const t = Math.hypot(x - cx, y - cy) / denom
  return 1 - (1 - MIN_FACTOR) * smoothstep(t)
}

// Smoothstep ramp in [0, 1] across the icon-offset transition zone.
// 0 below LOW (bottom-anchored), 1 above HIGH (visually center-anchored).
export function offsetEase(iconSize: number): number {
  return smoothstep((iconSize - ANCHOR_RAMP_LOW) / (ANCHOR_RAMP_HIGH - ANCHOR_RAMP_LOW))
}

// Offset in icon-canvas pixels along the y-axis. Mapbox multiplies this by
// icon-size at render time and positive-y means *down* on screen. With
// icon-anchor: 'bottom' the icon's bottom edge sits at the pin; pushing the
// bottom further down by half the native height effectively re-centers the
// artwork over the geographic point (equivalent to icon-anchor: 'center').
export function offsetY(iconSize: number): number {
  return (ICON_NATIVE_PX / 2) * offsetEase(iconSize)
}

// Per-pin cap based on screen geometry.
//
// We compute the cap *as if the icon were always centered on its pin* (i.e.
// lift = 0.5), giving a symmetric formula:
//   extent ≤ 2 × min(y, vh - y)   (vertical)
//   extent ≤ 2 × min(x, vw - x)   (horizontal)
//
// This is what makes magnification work the same way on both axes — without
// it, vertical position dominates because icon-anchor='bottom' makes the
// vertical cap much stricter than the horizontal one, and moving a pin
// horizontally barely changes its allowed size.
//
// For small icons the actual rendered lift is less than 0.5 (smoothstep ramp,
// see offsetEase). Those icons may extend a few pixels above the viewport
// top when their pin is near the top edge — the artwork clips, the stem
// (at the bottom of the sprite) stays visible at the coord. The proximity
// factor already shrinks pins near edges, bounding the clipping.
//
// Returns the cap as an iconSize value (not extent in pixels).
export function positionCap(
  x: number,
  y: number,
  vw: number,
  vh: number,
): number {
  const N = ICON_NATIVE_PX
  const verticalCap = (2 * Math.max(0, Math.min(y, vh - y))) / N
  const horizontalCap = (2 * Math.max(0, Math.min(x, vw - x))) / N
  return Math.min(verticalCap, horizontalCap)
}

export interface SizingResult {
  // Final icon-size to write to the feature's `iconSize` property (already
  // includes the proximity factor — read this verbatim into the Mapbox
  // layer's `icon-size`).
  iconSize: Float64Array
  // y-component of icon-offset in icon-canvas px (non-negative; positive-y
  // is down in Mapbox screen coords). x is always 0.
  offsetY: Float64Array
}

// Compute per-pin iconSize + offsetY for the current camera. Pure: takes a
// project function and viewport dimensions; doesn't touch Mapbox state.
//
// Algorithm: a single-pass, stateless variant of greedy sizing where each
// pairwise constraint is the smooth blend of the two possible greedy orderings
// for that pair ("i wins the pair" vs "j wins the pair").
//
//   1. Project every thinned pin to screen pixels.
//   2. Compute per-pin proximityFactor and the unconstrained max ucMax =
//      min(absMax, positionCap). ucMax is "what this pin would be if it had
//      no neighbors."
//   3. For each ordered pair (i, j):
//        s_ij = smoothstep over (dc_j - dc_i) where dc = distance to screen
//          center. s_ij + s_ji = 1 exactly; s_ij is 1 when i is at least
//          CROSSOVER_BLEND_PX closer to center than j, 0 when at least that
//          much farther, smoothstep in between.
//        shrunk_ij = the size pin i would have if pin j takes its full ucMax
//          first: (2 D / N - ucMax[j] * p[j]) / p[i], floored at MIN_SIZE.
//        pairCap_ij = s_ij * ucMax[i]  +  (1 - s_ij) * shrunk_ij.
//      At s_ij = 1 (i clearly wins) this is ucMax[i] — pin i reaches absMax,
//      pin j collapses to the proper leftover (matching plain greedy). At
//      s_ij = 0 it is shrunk_ij — pin i collapses, pin j reaches absMax. At
//      s_ij = 0.5 it's the average — both pins land between the two extremes.
//      The rendered no-overlap constraint rendered_i + rendered_j = 2 D / N
//      holds exactly at every blend value (modulo MIN_SIZE flooring).
//   4. base[i] = min over j of pairCap_ij, floored at MIN_SIZE.
//   5. Final iconSize = base × proximityFactor; offsetY computed from it.
//
// This replaces an earlier greedy-with-sort-hysteresis approach. Hysteresis
// only delayed the "winner swap" jump; the new formulation makes the entire
// per-pin size a continuous function of every pin's position, so there is no
// jump to delay. See docs/icon-magnification.md §7.
export function computeSizes(
  thinned: readonly ThinnedPin[],
  project: (lng: number, lat: number) => { x: number; y: number },
  vw: number,
  vh: number,
): SizingResult {
  const N = thinned.length
  const out: SizingResult = {
    iconSize: new Float64Array(N),
    offsetY: new Float64Array(N),
  }
  if (N === 0) return out

  const px = new Float64Array(N)
  const py = new Float64Array(N)
  const p = new Float64Array(N)
  const dc = new Float64Array(N)
  const ucMax = new Float64Array(N)
  const absMax = (ABS_MAX_FRAC * Math.min(vw, vh)) / ICON_NATIVE_PX
  const cx = vw / 2
  const cy = vh / 2

  for (let i = 0; i < N; i++) {
    const { event } = thinned[i]
    const { x, y } = project(event.lng, event.lat)
    px[i] = x
    py[i] = y
    p[i] = proximityFactor(x, y, vw, vh)
    dc[i] = Math.hypot(x - cx, y - cy)
    ucMax[i] = Math.min(absMax, positionCap(x, y, vw, vh))
  }

  const base = new Float64Array(N)
  const sigmaTwo = 2 * CROSSOVER_BLEND_PX
  for (let i = 0; i < N; i++) {
    let cap = ucMax[i]
    for (let j = 0; j < N; j++) {
      if (j === i) continue
      const dx = px[i] - px[j]
      const dy = py[i] - py[j]
      const D = Math.hypot(dx, dy)
      // Pin i's size if pin j takes its full ucMax (= the leftover greedy
      // would give pin i with pin j sized first).
      const shrunk = Math.max(
        MIN_SIZE,
        ((2 * D) / ICON_NATIVE_PX - ucMax[j] * p[j]) / p[i],
      )
      // Smoothstep share for pin i: 1 when i is CROSSOVER_BLEND_PX closer to
      // center than j, 0 when that much farther, smooth in between.
      const s = smoothstep((dc[j] - dc[i] + CROSSOVER_BLEND_PX) / sigmaTwo)
      const pairCap = s * ucMax[i] + (1 - s) * shrunk
      if (pairCap < cap) cap = pairCap
    }
    base[i] = Math.max(MIN_SIZE, cap)
  }

  for (let i = 0; i < N; i++) {
    const rendered = base[i] * p[i]
    out.iconSize[i] = rendered
    out.offsetY[i] = offsetY(rendered)
  }
  return out
}

// Returns the index of the thinned pin whose projected position is closest
// to the viewport center, or -1 if no pin is within CENTER_HOLD_FRAC ×
// min(vw, vh) of center. The radius is the "reasonable surface area" that
// keeps the description panel sticky against small pans.
export function findCenteredIndex(
  thinned: readonly ThinnedPin[],
  project: (lng: number, lat: number) => { x: number; y: number },
  vw: number,
  vh: number,
): number {
  if (thinned.length === 0) return -1
  const cx = vw / 2
  const cy = vh / 2
  const radius = CENTER_HOLD_FRAC * Math.min(vw, vh)
  const radiusSq = radius * radius
  let bestIdx = -1
  let bestDsq = Number.POSITIVE_INFINITY
  for (let i = 0; i < thinned.length; i++) {
    const { event } = thinned[i]
    const { x, y } = project(event.lng, event.lat)
    const dx = x - cx
    const dy = y - cy
    const dsq = dx * dx + dy * dy
    if (dsq < bestDsq) {
      bestDsq = dsq
      bestIdx = i
    }
  }
  if (bestIdx === -1 || bestDsq > radiusSq) return -1
  return bestIdx
}
