# Zoom and Pan Behavior

This document specifies how event icons respond to map zoom, pan, and viewport changes. It is the source of truth for the contract between `Map.tsx` and `thinning.ts`.

## Goals

1. **Hierarchical zoom**: as the user zooms in, more events become visible. Events never disappear when zooming further in.
2. **Maximal magnification without collision**: each visible icon expands to fill the screen space available to it, bounded by its nearest neighbor on one side and the viewport edges on the other.
3. **Smooth gesture feedback**: icon size animates continuously during pinch/scroll zoom and pan, not just when the gesture ends.
4. **No overflow**: an icon never extends past the visible viewport.

## State signals

`Map.tsx` tracks four pieces of state that drive rendering. They exist as separate signals because they update at different cadences and feed different parts of the pipeline.

| State          | Updated on                              | Drives                                               |
| -------------- | --------------------------------------- | ---------------------------------------------------- |
| `zoom`         | every `onMove` frame (zoom delta only)  | per-pin sizing (`sizeByNearestNeighbor`)             |
| `settledZoom`  | `onMoveEnd` only                        | thinning (`thinByPixelSeparation`) — visible pin set |
| `moveTick`     | every `onMove` frame (always)           | forces re-render so position cap recomputes on pan   |
| `viewportTick` | map `resize` event                      | re-runs the viewport-derived size cap on resize      |

### Why four signals?

- **`zoom` vs `settledZoom`**: thinning is expensive *and* visually disruptive — adding/removing pins mid-gesture causes pop-in/out. Sizing is cheap *and* visually critical during a gesture. So the two are decoupled: thinning waits for the gesture to end; sizing happens every frame.
- **`zoom` vs `moveTick`**: a pure pan keeps `zoom` constant. React's `setState` bails out via `Object.is`, so `setZoom(sameValue)` would not re-render — but the screen position of every pin has just changed, which means the position cap (see below) needs to recompute. `moveTick` is a monotonically increasing counter that forces re-render on every move frame regardless of zoom delta.
- **`viewportTick` vs `moveTick`**: window resize doesn't fire a map `move` event, so it needs its own signal. Splitting it out also avoids re-running the resize handler on every pan frame.

## Pipeline

```
events ──rankEvents──▶ ranked ──thinByPixelSeparation──▶ thinned ──sizeByNearestNeighbor──▶ sized ──positionCap──▶ pins ──▶ geojson ──▶ mapbox source
                                  (uses settledZoom)        (uses zoom)         (uses zoom + map.project)
```

Each stage memoizes on the prior stage's output plus the signals it consumes.

### Stage 1 — `rankEvents` (per fetch)

Sorts events globally by salience tier, then imminence, then a stable hash on `event.id`:

1. **Tier 0** (highest priority): `source_id === 'partiful'`, or `category ∈ {concert, comedy}`.
2. **Tier 1** (default): everything else.
3. **Tier 2** (lowest priority): `category ∈ {community, ugc, other}`.

Within a tier, sooner `starts_at` wins. Events with no `starts_at` sink to the bottom. Ties are broken by FNV-1a hash on `id` so the visible set is deterministic across reloads.

This stage runs once per fetch — independent of zoom and pan.

### Stage 2 — `thinByPixelSeparation` (per `settledZoom`)

Greedy Poisson-disk filter in Web Mercator pixel space at the current `settledZoom`:

```
for each event in ranked order:
  project to (x, y) in world pixels at settledZoom
  if no accepted pin within MIN_PIXEL_SEPARATION (20px):
    accept the pin, count = 1
  else:
    increment the nearest accepted pin's count
```

Because rank order is independent of zoom, the accepted set at zoom Z+1 is always a superset of the set at Z: pins only ever *appear* as the user zooms in, never disappear. This is the "hierarchical zoom" property.

Re-runs only when `settledZoom` changes (i.e., at `moveEnd`), so the visible pin set is stable during a gesture.

### Stage 3 — `sizeByNearestNeighbor` (per move frame)

For each thinned pin, finds the pixel distance to its nearest other thinned pin at the current `zoom`, and assigns:

```
iconSize = clamp(nearestDist / iconNativePx, minSize, maxSize)
```

Where:

- `iconNativePx = 110` — the icon sprite's CSS footprint at `icon-size = 1`.
- `minSize = MIN_PIXEL_SEPARATION / 110 ≈ 0.18` — keeps icons visible in worst-case clusters.
- `maxSize = min(viewport_width, viewport_height) / 110` — viewport-derived ceiling for lone pins.

**Geometry rationale**: approximating each icon as a circle of radius `(iconNativePx / 2) × iconSize` centered at the pin point, two same-sized neighbors at pixel distance `D` just touch when `iconSize = D / iconNativePx`. So that's the largest size at which no collision occurs.

A lone pin (no neighbors) takes `maxSize`.

### Stage 4 — position cap (per move frame)

After `sizeByNearestNeighbor`, each pin's `iconSize` is further clamped by its actual screen position. With `icon-anchor='bottom'`:

- Icon extends **upward** from the pin point by `iconSize × 110` CSS px.
- Icon extends **half-width to each side** by `iconSize × 55` CSS px.

For a pin projected to screen coordinates `(x, y)`:

```
verticalCap   = max(0, y) / 110                       // distance to top edge
horizontalCap = 2 × max(0, min(x, vw - x)) / 110      // 2× distance to nearer side
positionCap   = min(verticalCap, horizontalCap)
iconSize      = min(iconSize, positionCap)
```

This is what prevents a lone-visible pin at deep zoom (the other thinned pins are off-screen, so nearest-neighbor distance is huge) from overflowing the viewport.

**Off-screen pins** (`y ≤ 0` or `x ∉ [0, vw]`) collapse to `iconSize = 0`. They're invisible while off-screen and reappear at full size when panned in — no half-icon dangling at an edge.

## Behavior matrix

| Gesture                  | Triggers                                            | Effect                                                                  |
| ------------------------ | --------------------------------------------------- | ----------------------------------------------------------------------- |
| Pure pan (no zoom)       | `onMove` → `setZoom(same)` bails, `setMoveTick(+1)` | Pins re-projected, position caps updated, source data pushed each frame |
| Pinch/scroll zoom        | `onMove` → `setZoom(new)`, `setMoveTick(+1)`        | `pins` recomputed each frame with new nearest-neighbor distances        |
| Gesture end (any)        | `onMoveEnd` → `setSettledZoom(new)`                 | Thinning re-runs; new pins may appear (zoom-in) but never disappear     |
| Window resize            | mapbox `resize` event → `setViewportTick(+1)`       | `maxSize` and position caps recompute against the new viewport          |
| Map style/source reload  | `useEffect` on `[mapLoaded, events]`                | Icons re-registered into the sprite; rendering paused until ready       |

## Why source-data updates, not a `["zoom"]` expression in the layer

Mapbox GL symbol layers (`type: 'symbol'`) cache the *layout-time* evaluation of any data-driven `icon-size` expression. Once a symbol is laid out for a tile, its size is baked into the vertex buffer; a `["zoom"]`-driven scale factor in the layer expression does **not** cause per-frame re-evaluation. The size only updates when the symbol layout pass re-runs — which happens on source data changes.

So the only reliable way to animate per-pin icon size during a gesture is to push fresh per-feature `iconSize` values through `source.setData` on every frame. That's what the `pins → geojson → Source data` pipeline does.

A `["zoom"]`-driven expression *would* work for a pure zoom-driven (non-data-driven) `icon-size`, but we need per-pin variation, so this route is closed.

## Performance notes

- Thinning is `O(N²)` on the full event set (`N ≤ 200`). Runs only at `moveEnd`.
- Sizing is `O(M²)` on the thinned set (`M ≤ ~20` typical). Runs every move frame. Trivial.
- `map.project` is called per visible pin per frame. Constant-time and cheap.
- `source.setData` per frame causes a symbol layout pass for the ~5–20 visible features. Measured in low single-digit ms; well within the 16ms frame budget.
- React's `setState` bail-out filters out frames where neither `zoom`, `moveTick`, nor `viewportTick` changed — i.e., idle frames cost nothing.

## Tunable knobs

All in `src/thinning.ts`:

- `MIN_PIXEL_SEPARATION` (default `20`): minimum pixel gap between accepted pins during thinning. Smaller = denser pin set; larger = sparser.
- `sizeByNearestNeighbor` options:
  - `iconNativePx` (default `110`): the icon's CSS footprint. Lower values let icons grow larger for the same gap (allows visual overlap of transparent padding).
  - `minSize` (default `MIN_PIXEL_SEPARATION / 110`): floor for clustered pins.
  - `maxSize` (default `15`, but `Map.tsx` overrides with the viewport-derived value): ceiling for isolated pins.
