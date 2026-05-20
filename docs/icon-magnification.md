# Event-icon magnification and miniaturization

This document describes the intended behavior of the per-frame icon sizing system on the map: how icons grow and shrink in response to camera position, how they avoid overlap, and which trade-offs are deliberate.

Read this before changing anything about icon sizing. Several pieces of the design are counter-intuitive, and the obvious "simplification" usually undoes a defect that was previously reported and fixed.

## 1. What this system is for

The app renders live events as illustrated icons (or category emojis) on a Mapbox map. Unlike traditional map pins, these icons are bitmap artwork that scales — sometimes substantially — based on where the user has the camera. The intent is:

- The icon nearest to the screen center is the user's current focus. It should grow large enough to dominate the viewport.
- Icons further from the center should shrink, communicating "you're looking at the center, not here."
- Two icons must never visually overlap; that would obscure their artwork and the count badge.
- The behavior should feel continuous during pan and zoom — no popping, no flicker, no perceptible jumps as a threshold is crossed.

The user evaluates this system visually. If a change makes magnification feel "snappy" or "asymmetric" or "stuck at half size," it's wrong, even if the math reads cleanly.

## 2. Invariants

These hold at all times, on every frame:

1. **No overlap.** For any two visible icons, the sum of their on-screen radii is less than or equal to their on-screen center-to-center distance. (Each icon is treated as a disk for collision purposes, even though the artwork is rectangular — the disk model is conservative.)
2. **Bounded maximum.** No icon ever renders larger than a fixed fraction of the smaller viewport dimension, regardless of how isolated it is. This ceiling prevents a lone pin from blowing through the viewport entirely.
3. **Bounded minimum.** No icon shrinks below a fixed floor. Below that the icon would become unclickable and visually meaningless.
4. **Center wins.** When two pins are close enough that they would overlap at full size, the one nearer to the screen center takes priority and grows; the further one shrinks to fit. The brief crossover band, where the two pins are within `CROSSOVER_BLEND_PX` of equidistant from center, is an exception: the two sizes meet at a transient midpoint while the camera passes through. Steady-state balanced sizing — both pins permanently at a compromise mid-size, as a symmetric fixed-point solver would produce — is still explicitly rejected.
5. **Axes are symmetric.** Moving an icon horizontally has the same effect on its size as moving it vertically by the same number of pixels. There is no axis bias.
6. **Stable visible set during a gesture.** Which icons are visible is decided once, when a gesture ends; sizes update continuously during the gesture, but the set of pins doesn't pop in and out.

If any of these invariants would be violated by a proposed change, the change is wrong.

## 3. The pipeline, conceptually

For each frame during a pan or zoom gesture (and once when the gesture settles), the following happens:

1. Each thinned pin is projected from its geographic coordinate into a pixel position on the current canvas.
2. For each pin, a **proximity factor** is computed — a multiplier in a small range that depends only on how far the pin is from the screen center.
3. For each pin, a **position cap** is computed — a geometric ceiling that prevents the icon from extending too far past the viewport edges.
4. A **pairwise overlap solver** computes each pin's base size as a smooth blend of two greedy assignments per neighbor ("this pin wins the pair" vs "the other pin wins"). At the extremes the blend collapses to plain greedy (closer pin at full allowance, farther pin at the constrained leftover); across the crossover it interpolates continuously, eliminating the one-frame winner-swap.
5. Each pin's final rendered size is its solver-assigned base size multiplied by its proximity factor.
6. From the final rendered size, an **anchor lift** is computed — a vertical offset that smoothly shifts the icon's visual position from "bottom of artwork sitting at the coord" (for small icons) toward "icon centered on the coord" (for large icons).
7. The sizes and offsets are pushed to Mapbox as feature properties; the symbol layer reads them via plain `get` expressions.

Each step is described in detail below.

## 4. The proximity factor

The proximity factor is a smooth, axis-symmetric multiplier that approaches 1 at the screen center and approaches a configurable floor at the edges.

The factor is derived from Euclidean distance to the screen center, normalized by a fraction of the viewport's diagonal. Using the diagonal (rather than half-width, half-height, or half of the smaller dimension) is essential — those alternatives saturate the falloff at different distances in x versus y and produce visible axis bias. The diagonal is rotation-invariant.

The normalized distance is fed through a smoothstep curve (the standard cubic ease, flat at both endpoints, monotonically increasing in the middle). Two properties of the smoothstep matter:

- It is **flat near zero**. Tiny pans near the center don't perturb the center pin's size at all. Without this, the factor would visibly wiggle on every cursor twitch.
- It is **flat near one**. Pins way out at the screen corners don't keep shrinking past the configured floor; they sit at the floor.

The factor's floor is the largest possible miniaturization for a pin still on the map. A lower floor produces more dramatic shrinkage but feels harsh during ordinary panning; a higher floor feels too subtle. The current floor (0.7) was chosen because lower floors felt "too fast" to the user.

The factor is **not** a "size" — it is a multiplier. A pin's base size (from the solver) is multiplied by the factor to produce its final rendered size.

### Why the factor and the solver are kept separate

A natural implementation would fold proximity into the overlap constraint itself — for example, "a pin's allowed size is proportional to its proximity." This was tried in an earlier iteration. It fails because:

- The user expects the **center pin** to reach the **absolute maximum**, not a proximity-scaled fraction of it.
- A symmetric or proximity-weighted constraint causes two nearby pins to converge to a balanced size; neither reaches the maximum.

Keeping the proximity factor as a post-multiplier, applied only when computing the final rendered size, lets the overlap solver hand the center pin its full allowance while the proximity factor naturally shrinks pins further from the center.

## 5. The position cap

The position cap prevents an icon from extending well past the viewport boundary. It's computed independently for each pin from the pin's projected screen position.

A subtle but important choice: **the position cap is symmetric in x and y, computed as if the icon were always centered on its pin coordinate**, even though small icons are actually rendered bottom-anchored.

To see why this matters, consider the alternative — a "physically accurate" cap that accounts for the actual anchor:

- A bottom-anchored icon extends upward from its pin. The geometric limit is then "how much space is above the pin," which is proportional to the pin's y-coordinate.
- A horizontally-centered icon extends to both sides. The geometric limit is proportional to the distance to the nearer left/right edge.

Under the physically-accurate cap, a pin near the top of the screen has a tiny allowed size regardless of its x-position; a pin at center-y but near the right edge is much less constrained. Vertical position dominates icon size; horizontal motion barely affects anything. The user reported this as "magnification only works on the y-axis."

The symmetric cap formula — "the allowed extent is twice the distance to the nearer edge, computed the same way on both axes" — removes the bias. Small icons whose pin is near the top edge may render with their top edge a few pixels off-screen. This is acceptable: the proximity factor already shrinks pins near edges, so the off-screen excursion is bounded. (For large icons, the anchor-lift ramp puts them mostly center-anchored, so the symmetric cap is geometrically exact.)

The position cap has no dependence on the icon's current size estimate. It is purely a function of viewport dimensions and the pin's screen position. This makes it cheap to compute and stable across the solver's pass.

## 6. The absolute maximum

A configurable cap on rendered size, expressed as a fraction of the smaller viewport dimension. This is what makes "lone pin at center fills ~80% of the screen" a stable target — without it, a sufficiently isolated pin would have nothing to limit its growth except the position cap, which at center is large.

The absolute maximum is the size a lone pin gets when it is at the screen center. The solver caps every pin's `ucMax` (unconstrained max) at this value before applying any pairwise constraint.

## 7. The overlap solver

This is the core algorithm and the one most likely to be incorrectly "improved." Read this section carefully.

### What it does

The solver assigns each pin a **base size**: the multiplier the symbol layer will use, before the proximity factor is folded in. The base size respects three constraints simultaneously: it is at most the absolute maximum, at most the pin's position cap, and small enough that the pin does not overlap any neighbor.

### How it does it

For each pin `i`:

1. Compute the **unconstrained max** `ucMax[i] = min(absMax, posCap[i])` — the size pin `i` would have with no neighbors.
2. For every other pin `j`, compute a pairwise cap that blends two greedy assignments — "pin `i` wins the pair" and "pin `j` wins the pair":
   - `shrunk_ij` = the size pin `i` would have if pin `j` takes its full `ucMax[j]` first, i.e. the leftover that plain greedy would give pin `i` when pin `j` is sized first: `(2 × D_ij / native_icon_pixels − ucMax[j] × proximity_j) / proximity_i`, floored at `MIN_SIZE`.
   - `s_ij` = pin `i`'s share of the pair, computed as `smoothstep((dc[j] − dc[i] + CROSSOVER_BLEND_PX) / (2 × CROSSOVER_BLEND_PX))`, where `dc[i]` is the screen-pixel distance from pin `i` to the viewport center. The value is 1 when pin `i` is at least `CROSSOVER_BLEND_PX` closer to center than pin `j`, 0 when at least that much farther, smoothstep in between. By construction `s_ij + s_ji = 1` exactly.
   - `pairCap_ij = s_ij × ucMax[i] + (1 − s_ij) × shrunk_ij`.
3. `base[i] = max(MIN_SIZE, min over j of pairCap_ij)`.

At the extremes (`s_ij = 0` or `1`), the formulation reduces to plain greedy: the closer pin is at `ucMax`, the farther pin is at the leftover. The center pin still reaches absolute max in steady state. Across the crossover (`s_ij ≈ 0.5`), both pins land at the midpoint between their winning and losing sizes, and the assignment moves continuously between the two extremes as the camera pans. This continuity is the whole point — the older implementation sorted the pins, walked the list in order, and produced a discrete winner-swap any time two pins' proximity factors crossed during a pan. The user saw it as a one-frame jump in both icons' sizes; the pair-blend eliminates it.

### Why not a fixed-point relaxation

A symmetric fixed-point solver iterates per-pin sizes against neighbors until convergence and produces **balanced** sizing: two pins close enough to constrain each other end at similar sizes, with neither reaching the absolute maximum. This was tried in an earlier iteration and the user rejected it visually: "the centered icon needs to be rendered in max size, and the icon to the right should be smaller." A symmetric fixed-point cannot deliver that.

The pair-blend keeps the asymmetric "center wins" property outside the crossover band: when `s_ij` is 1, pin `i` is at `ucMax` and pin `j` is at the constrained leftover, identical to plain greedy. Inside the crossover band (when `|dc[i] − dc[j]| < CROSSOVER_BLEND_PX`) the asymmetry softens into a smooth handoff, which is the only place where balanced sizing applies — and only transiently, while the camera is passing through the crossover.

### Why not a hash-based stable tiebreaker

An obvious cheap "fix" for the swap is to add a stable tiebreaker (such as a hash of the event ID) so that ties resolve consistently. This was tried in spirit by an earlier sort-hysteresis scheme; both share the same flaw. Two pins pass through exact proximity equality only on isolated frames of float-arithmetic flukes; the visible jump is caused by the *near*-equal crossover where the sort algorithm flips its result, not by exact ties. Stable tiebreaking does nothing for the near-equal case. The pair-blend does, because it makes the per-pin size a continuous function of every pin's screen position rather than the discrete output of a sort.

### Why not sort-order hysteresis

A hysteresis on the sort comparator (preserve the previous frame's order while the proximity-factor gap sits inside a dead-band) was the prior implementation. It made small pans around the crossover stable, but a decisive pan past the dead-band produced the same one-frame swap as the un-hysteresis greedy — the jump was merely delayed to a slightly larger proximity gap. At zoom levels where the gap traverses the dead-band quickly, the user still saw the discontinuity. The pair-blend removes the jump entirely because there is no discrete decision to delay.

### The pairwise overlap constraint

For two pins, the rendered sizes (base × proximity) and the inter-pin pixel distance must satisfy:

> rendered_i × native_icon_pixels / 2  +  rendered_j × native_icon_pixels / 2  ≤  pixel_distance_ij

That is: the sum of the two on-screen radii is at most the on-screen distance. The pair-blend formulation makes this an *equality* (modulo `MIN_SIZE` flooring) at every value of `s_ij`: pick any blend, write out the two rendered sizes, and the cross terms cancel. The two pins together always use exactly the budget `2 × D / native_icon_pixels` when they constrain each other.

The constraint is **pairwise**, not cluster-aware. In a tight three-or-more-pin cluster, pin `i`'s pair-cap against pin `j` uses `ucMax[j]` (the worst case for pin `i`), even if pin `j` is itself shrunk by another neighbor. The result is occasionally a slightly smaller third+ pin than a globally optimal sizer would produce. For the visible-pin counts we deal with (a few dozen at most), the effect is small and visually acceptable.

### Tuning

`CROSSOVER_BLEND_PX` is the half-width of the smooth crossover zone, in screen pixels. Wider means a longer "co-dominant" zone during a pan and more time spent at the blend midpoint; narrower brings behavior closer to plain greedy at the cost of a sharper crossover. Adjust by visual evaluation in the running app, not in the abstract.

## 8. The anchor lift

Icons are rendered through Mapbox's symbol layer with `icon-anchor: 'bottom'`. With no offset, the bottom edge of the artwork sits exactly at the pin coordinate.

For small icons this is fine. For large icons, it imposes a hard geometric ceiling: a pin at the vertical center of the screen can grow upward at most by half the viewport height before its top hits the screen top. The icon caps at about 50% of the viewport, well short of the 80% target.

The anchor lift breaks this ceiling. As the rendered size grows past a threshold, a positive vertical icon-offset is applied. The offset is in icon-canvas pixels and is multiplied by the icon's size at render time, so as the icon grows, the lift grows proportionally. At full lift, the offset equals half the icon's native canvas height, which is equivalent to switching to `icon-anchor: 'center'` — the icon's center sits at the pin coordinate, and the icon extends both above and below.

The lift is computed by another smoothstep, mapping rendered size onto the offset:

- Below a lower threshold: zero lift. Icon is bottom-anchored.
- Above an upper threshold: full lift. Icon is centered on the coord.
- Between: smooth ramp. The icon's bottom edge appears to drift downward, pulling the artwork upward visually.

The transition is continuous; there is no anchor swap, no discrete jump. A previous design proposed flipping `icon-anchor` from `'bottom'` to `'center'` at a threshold, which would cause a one-frame visual jump equal to half the icon's rendered height. The continuous offset avoids this.

### Why the location-indicator dot was removed

Earlier versions of the asset icons baked a small blue dot-and-stem indicator into the bottom strip of the sprite, so the user could see exactly which point on the map the icon referred to. This worked under bottom-anchor with zero offset: the dot was at the pin's coordinate.

Under the anchor-lift ramp, the entire sprite (including the dot) shifts down by the lift amount, so the dot no longer points at the actual coord — it points to a location below it. The drift grows continuously with the icon's size.

Attempts to keep an indicator accurate under lift involved either a separate symbol layer for the dot (rendered without lift), or scaling the indicator inversely to the artwork. Both add complexity. The user opted to remove the indicator entirely; the artwork itself now occupies the full sprite and serves as its own location marker. This was deemed acceptable because the icons are illustrated, distinctive, and large enough that locating them on the map is unambiguous.

Do not re-introduce a stem or dot inside the sprite without first solving the anchor-lift drift problem. If a future change reverts the anchor-lift to bottom-only (giving up the 80% fill target), a sprite-baked indicator becomes correct again.

## 9. How the pieces compose

For each pin on each frame:

> rendered_size_i  =  proximity_factor_i  ×  base_size_i

where base_size_i comes from the overlap solver, and proximity_factor_i depends only on the pin's screen position.

> visual_lift_i  =  smooth_ramp(rendered_size_i)  ×  native_canvas_half_height

where the smooth ramp maps the rendered size onto [0, 1] over the configured threshold range.

The symbol layer reads rendered_size_i as `icon-size` and (0, visual_lift_i) as `icon-offset`. Mapbox handles the rendering: positions, scaling, the offset multiplied by `icon-size` at draw time.

## 10. Edge cases

### A single, isolated pin centered on screen

No pairwise constraints apply. `ucMax` is the absolute maximum. The proximity factor is 1. Final rendered size equals the absolute maximum. The icon fills ~80% of the smaller viewport dimension. The anchor lift is at full, so the icon is centered on the coord.

### A single pin at the corner of the viewport

Position cap is at or near zero (the pin is at an edge). Proximity factor is at the floor (the pin is far from center). The base size collapses to the minimum size; the rendered size is minimum_size × floor. The icon is small and barely visible. This is intentional — the pin is barely on-screen; magnifying it would be misleading.

### Two pins, both at screen center

Pathological but possible during dense thinning glitches. Both pins have proximity factor 1 and `dc = 0`, so `s_ij = 0.5` and `shrunk_ij` is negative (forced to `MIN_SIZE`). Both pins collapse to roughly the minimum-floor size. Visually: two almost-invisible icons on top of each other. Acceptable degenerate behavior — the thinning step is supposed to prevent this configuration, so seeing it indicates a thinning bug rather than a sizing bug.

### Two pins at equal distance from the center, on opposite sides

Their distance-to-center difference is zero, so `s_ij = 0.5` for the pair. Each pin's pairwise cap is the arithmetic mean of `ucMax` and `shrunk` — neither pin reaches absolute max, both land at the midpoint between the two greedy assignments. As the user pans, `s_ij` slides smoothly toward 0 or 1, and the two pins move continuously between the midpoint and the standard "one at max, other at leftover" assignment. No jump.

### A dense cluster of many pins

The pair-blend produces a clear hierarchy: the centermost pin is at `ucMax`; each other pin's `pairCap` against the central one is `shrunk` (constrained by the central pin's full footprint). In a tight cluster, all pins beyond the first few floor at the minimum size. Visually: one dominant icon and a halo of tiny ones. This is the intended "focus" effect.

### Panning an icon from screen center to the edge

Proximity factor decreases smoothly via the smoothstep curve. Position cap decreases smoothly as the pin nears the edge. The pin's `s_ij` against any neighbor slides smoothly as its distance-to-center changes. The icon's size decreases smoothly throughout. No pop.

### Zooming in or out

The thinned set is recomputed when the gesture settles, not continuously. During the zoom gesture, the same set of pins is visible, and they re-size continuously. When the gesture ends, the visible set may change (more pins at high zoom, fewer at low zoom). On the next frame, the overlap solver runs over the new set; new pins are sized fresh.

### Resizing the browser window

Viewport dimensions change. The absolute maximum, the position caps, the proximity-factor normalizer, all derive from the viewport dimensions and re-evaluate on the next size update. A resize handler triggers one immediate size pass so the icons don't sit stale at the old viewport's sizes.

### Very small viewports (e.g. mobile)

Absolute maximum is proportional to the smaller dimension, so it scales naturally. The proximity-factor diagonal also scales. The behavior remains the same in proportion, just smaller in absolute pixels. The minimum-size floor may become noticeable on small screens — a tuning point if mobile becomes a target.

### The thinned set is empty

The solver does nothing; no icons render. The rest of the system (camera, controls, popups) continues to function.

### The thinned set changes mid-gesture

This shouldn't happen — thinning runs only when the gesture settles. If it does happen due to a bug elsewhere, the solver handles it gracefully: the new pin set is processed on the next frame.

## 11. How the per-frame loop runs

Sizing is computed every animation frame between the start and end of a pan/zoom gesture. The loop reads the current camera state directly from Mapbox, projects each pin, runs the math described above, and writes the results into the GeoJSON source's feature properties. The symbol layer's `icon-size` and `icon-offset` expressions read those properties and re-render.

Two important properties of this loop:

- It does **not** route through React state. Per-frame updates to icon size do not trigger React re-renders, do not create new GeoJSON objects, and do not pass through any controlled component prop. The data update goes directly to Mapbox via its imperative source API. Routing through React's render cycle was the original cause of pan-time flicker.
- The same loop is responsible for the final "settled" frame after a gesture ends. There is one size pass on gesture end (so the settled frame is up to date), one on viewport resize, and the per-frame stream during a gesture.

Outside a gesture, the icons are not re-sized. If something external (an event filter change, an icon-loading completion) requires a re-size, the relevant code path must trigger an explicit pass.

## 12. Why icon-size cannot use Mapbox `feature-state`

A natural Mapbox idiom for per-feature animated values is `feature-state`: programmatically set per-feature state values, and have style expressions read them. This works for paint properties.

`icon-size` and `icon-offset` are **layout** properties. Mapbox does not allow `feature-state` expressions in layout properties — only in paint or filter expressions. A layer expression like `['feature-state', 'iconSize']` in `icon-size` will evaluate to null, and any fallback will produce zero-size icons.

The system therefore uses the older idiom: per-feature values live in feature **properties**, and the layer reads them via `['get', 'iconSize']`. The per-frame loop updates the feature properties and calls `setData()` to push.

Do not migrate `icon-size` to `feature-state`. It looks cleaner but does not work.

## 13. Tunable parameters and what they control

The system has a small number of tuning constants. Their semantic meaning, in plain words:

- **Proximity floor.** The smallest value the proximity factor can take. Lower values produce more dramatic shrinkage at the edges; higher values keep all pins close to their unscaled size. The current value is moderate. Going lower has been tried and rejected as "too fast" by the user.
- **Proximity normalizer fraction.** How fast the proximity factor reaches its floor as a pin moves from center to corner. Larger values produce a gentler falloff (the floor is reached only deep in the corner); smaller values cause the factor to plateau closer to the center.
- **Absolute maximum fraction.** The fraction of the smaller viewport dimension that a lone-centered pin fills. The current value gives ~80% fill.
- **Anchor-lift thresholds.** The lower and upper rendered-size values between which the anchor lift ramps from zero to full. Below the lower threshold, icons render bottom-anchored. Above the upper threshold, they render center-equivalent. The width of this transition controls how perceptible the lift feels during scaling.
- **Minimum size.** A floor on rendered size, primarily for clickability.

Changes to these values should be evaluated visually, in the running app, not just in the abstract. Each one interacts subtly with the others.

## 14. Failure modes to watch for

If a future change causes any of these symptoms, the change is wrong:

- **Flicker during pan.** Almost certainly caused by per-frame updates going through React's render cycle, or by toggling the GeoJSON source via a controlled component prop. The per-frame loop must call `setData()` directly.
- **Y-axis dominates magnification.** The position cap is using anchor-aware (asymmetric) geometry instead of the symmetric formula. Make sure both axes use the same "twice the distance to the nearer edge" form.
- **The center pin never reaches max size when a neighbor is on-screen.** `CROSSOVER_BLEND_PX` is too wide (the center pin is being held in the blend midpoint instead of reaching `ucMax`) or the pair-blend has regressed to a symmetric fixed-point that doesn't reduce to `s_ij = 1 → ucMax` at the extremes.
- **Magnification feels too aggressive on small pans.** The proximity factor's curve is linear or too steep near zero. Use smoothstep (or a higher-order ease) so the factor is flat near the center.
- **The icon pops visibly as it crosses some size threshold.** The anchor handling is switching `icon-anchor` discretely instead of ramping the offset continuously. Use the continuous offset.
- **Two near-equidistant pins swap sizes discontinuously during a pan.** The pair-blend has regressed to a hard sort. Verify `computeSizes()` is using `s_ij × ucMax + (1 − s_ij) × shrunk` and that `CROSSOVER_BLEND_PX` is non-zero. Symptom is a one-frame jump rather than a smooth interpolation across the crossover.
- **The location dot/stem is back at the bottom of the artwork and drifts as the icon grows.** See Section 8.

## 15. Things this system deliberately does not do

- It does not use Mapbox's built-in symbol collision detection. The layer is configured with collision allowed and placement ignored, because the JavaScript-side overlap solver fully owns the no-overlap invariant.
- It does not animate sizes with CSS or DOM transitions. Icons are sprites in a WebGL symbol layer; there is no DOM per icon.
- It does not consider event "importance" or rank for sizing. Importance affects which events are visible (the thinning step), but once an event is visible, sizing depends only on its current screen position relative to other visible icons. A high-importance event off in the corner is the same size as a low-importance one in the corner.
- It does not cache projected positions between frames. Every frame projects from scratch; this is cheap and avoids stale-projection bugs.

## 16. Open trade-offs left in place

- **In the crossover band, neither pin reaches absolute max.** Both sit at the blended midpoint between `ucMax` and `shrunk`. This is the price of continuity; outside the band the closer pin still reaches `ucMax`. The band width (`CROSSOVER_BLEND_PX`) is tunable.
- **The pair-blend is not globally optimal.** Each pairwise cap is computed against a neighbor's `ucMax` (the worst case for the pin in question), not the neighbor's actual constrained size. In tight three-or-more-pin clusters this slightly over-shrinks the third+ pin compared to a globally optimal sizer. Not a problem in practice for the visible-pin counts we deal with.
- **Small icons near the top edge can clip a few pixels off-screen.** A consequence of the symmetric position cap; deemed acceptable because the proximity factor shrinks edge pins anyway, bounding the excursion.
- **No "importance"-weighted sizing.** A future product call may want the center icon's importance to factor into how aggressively it dominates. Currently importance only affects visibility.
