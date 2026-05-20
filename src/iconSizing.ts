// Per-pin icon sizing for the map's event symbol layer.
//
// The user-visible invariants this module enforces:
//   1. No two icons ever overlap (anti-overlap solved as a small fixed-point
//      relaxation across pairwise constraints, because magnification varies
//      per pin).
//   2. Pins near the screen center magnify; pins farther away miniaturize.
//      The falloff is a smoothstep across the viewport diagonal, so tiny
//      pans don't perturb center pins.
//   3. A lone visible pin scales to fill ~ABS_MAX_FRAC of the smaller
//      viewport dimension, accomplished by ramping a negative `icon-offset`
//      that lifts the artwork as it grows (visually equivalent to swapping
//      icon-anchor from 'bottom' to 'center', but continuous — no jump).
//
// All functions here are pure and unit-testable. The rAF loop in Map.tsx
// calls computeSizes() once per frame during a gesture.

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
// top when their pin is near the top edge — the artwork artwork clips, the
// stem (at the bottom of the sprite) stays visible at the coord. The
// proximity factor already shrinks pins near edges, bounding the clipping.
//
// `ease` is kept in the signature for future use but is unused; the cap is
// intentionally independent of the current lift.
//
// Returns the cap as an iconSize value (not extent in pixels).
export function positionCap(
  x: number,
  y: number,
  vw: number,
  vh: number,
  _ease: number,
): number {
  const N = ICON_NATIVE_PX
  const verticalCap = (2 * Math.max(0, Math.min(y, vh - y))) / N
  const horizontalCap = (2 * Math.max(0, Math.min(x, vw - x))) / N
  return Math.min(verticalCap, horizontalCap)
}

export interface SizingResult {
  // Final icon-size to write to feature-state (already includes the
  // proximity factor — read this verbatim into the Mapbox layer).
  iconSize: Float64Array
  // y-component of icon-offset (icon-canvas px, negative). x is always 0.
  offsetY: Float64Array
}

// Compute per-pin iconSize + offsetY for the current camera. Pure: takes a
// project function and viewport dimensions; doesn't touch Mapbox state.
//
// Algorithm:
//   1. Project every thinned pin to screen pixels.
//   2. Compute per-pin proximityFactor (independent).
//   3. Fixed-point: each pin's allowed *base* size is the min of (positionCap,
//      ABS_MAX, and the pairwise no-overlap cap given current neighbor sizes).
//      Three iterations converge for the typical N (<= ~200).
//   4. Final iconSize = base × proximityFactor; offsetY computed from it.
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
  const posCap = new Float64Array(N)
  const absMax = (ABS_MAX_FRAC * Math.min(vw, vh)) / ICON_NATIVE_PX

  for (let i = 0; i < N; i++) {
    const { event } = thinned[i]
    const { x, y } = project(event.lng, event.lat)
    px[i] = x
    py[i] = y
    p[i] = proximityFactor(x, y, vw, vh)
    // Position cap is symmetric across both axes (independent of the offset
    // ramp). See positionCap docstring for why.
    posCap[i] = positionCap(x, y, vw, vh, 0)
  }

  // Greedy sizing in priority order: pins closer to the screen center (higher
  // proximity factor) get sized first, taking their full allowed size; later
  // pins shrink to fit against already-placed neighbors. This is intentionally
  // asymmetric — a symmetric fixed-point solver lets two nearby pins converge
  // to similar mid-sized values, but the user expectation is "the center pin
  // is always full size; the others give way". Greedy delivers that.
  const order = Array.from({ length: N }, (_, i) => i)
  order.sort((a, b) => p[b] - p[a])

  const base = new Float64Array(N)
  for (const i of order) {
    let cap = Math.min(absMax, posCap[i])
    // Only already-sized neighbors (those earlier in `order`) constrain this
    // pin. Their sizes are fixed; this pin shrinks if needed to fit.
    for (const j of order) {
      if (j === i) continue
      if (base[j] === 0) continue // not sized yet (later in order)
      const dx = px[i] - px[j]
      const dy = py[i] - py[j]
      const D = Math.hypot(dx, dy)
      // Pairwise overlap constraint: size_i × p_i + size_j × p_j ≤ 2 D / N.
      const ijCap = ((2 * D) / ICON_NATIVE_PX - base[j] * p[j]) / p[i]
      if (ijCap < cap) cap = ijCap
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
