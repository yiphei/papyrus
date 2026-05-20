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
4. **Center wins.** When two pins are close enough that they would overlap at full size, the one nearer to the screen center takes priority and grows; the further one shrinks to fit. (The fixed-point alternative — both pins compromise to a balanced mid-size — is explicitly rejected.)
5. **Axes are symmetric.** Moving an icon horizontally has the same effect on its size as moving it vertically by the same number of pixels. There is no axis bias.
6. **Stable visible set during a gesture.** Which icons are visible is decided once, when a gesture ends; sizes update continuously during the gesture, but the set of pins doesn't pop in and out.

If any of these invariants would be violated by a proposed change, the change is wrong.

## 3. The pipeline, conceptually

For each frame during a pan or zoom gesture (and once when the gesture settles), the following happens:

1. Each thinned pin is projected from its geographic coordinate into a pixel position on the current canvas.
2. For each pin, a **proximity factor** is computed — a multiplier in a small range that depends only on how far the pin is from the screen center.
3. For each pin, a **position cap** is computed — a geometric ceiling that prevents the icon from extending too far past the viewport edges.
4. A **greedy overlap solver** walks the pins in order of proximity (closest to center first), assigning each pin its largest allowed size given the position cap, the absolute maximum, and the constraint that it must not overlap any pin already placed.
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

Keeping the proximity factor as a post-multiplier, applied only when computing the final rendered size, lets the greedy solver hand the center pin its full allowance while the proximity factor naturally shrinks pins further from the center.

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

The absolute maximum is the size a lone pin gets when it is at the screen center. The greedy solver caps every pin's allocation at this value before applying any pairwise constraint.

## 7. The greedy overlap solver

This is the core algorithm and the one most likely to be incorrectly "improved." Read this section carefully.

### What it does

The solver assigns each pin a **base size**: the multiplier the symbol layer will use, before the proximity factor is folded in. The base size respects three constraints simultaneously: it is at most the absolute maximum, at most the pin's position cap, and small enough that the pin does not overlap any neighbor.

### How it does it

1. The pins are sorted by their proximity factor, descending. The pin nearest the screen center is first; the pin furthest from center is last.
2. The solver walks the sorted list in order, assigning each pin its size:
   - The candidate cap starts at the minimum of the absolute maximum and the pin's position cap.
   - For every pin earlier in the order — that is, every pin already assigned a size — the solver checks the pairwise overlap constraint. If the constraint would be violated at the candidate cap, the cap is reduced to whatever value satisfies it.
   - The final assigned size is the candidate cap, floored at the minimum size.
3. Once assigned, a pin's size is fixed. Subsequent pins must work around it; it does not get re-evaluated.

### Why greedy and not a fixed-point relaxation

A fixed-point solver iterates: each pin's size is recomputed against the current sizes of all neighbors; after a few passes, the sizes converge.

The fixed-point solver produces **balanced** sizing. Two pins close enough that they constrain each other end up at similar sizes, with neither reaching the absolute maximum. This was the previous implementation. The user evaluated it visually and rejected it: "the centered icon needs to be rendered in max size, and the icon to the right should be smaller." A symmetric fixed-point cannot deliver that, because by construction it treats both pins symmetrically.

The greedy solver delivers asymmetric priority: the center pin "wins" because it is sized first, with no constraints to bind it. Subsequent pins are constrained by what the center pin took.

### The pairwise overlap constraint

For two pins, the rendered sizes (base × proximity) and the inter-pin pixel distance must satisfy:

> rendered_i × native_icon_pixels / 2  +  rendered_j × native_icon_pixels / 2  ≤  pixel_distance_ij

That is: the sum of the two on-screen radii is at most the on-screen distance. Solving for the size of pin i, given an already-fixed pin j, this rearranges to give an upper bound on the base size of pin i in terms of pin j's known rendered size.

The constraint is **pairwise**, not cluster-aware. With three or more pins arranged in a tight cluster, the greedy order matters — the second pin's size is constrained only by the first; the third by the first and the second; and so on. This is sufficient for the visible-pin counts we deal with (a few dozen at most) and easy to reason about.

### Tie-breaking

Two pins at almost-identical distance from the screen center are sorted with no particular preference between them. As the user pans, their proximity-factor order can flip, and the greedy assignment will swap which one is "winner." For most clusters this is invisible (their factors are similar, so their sizes are similar). For obvious symmetric arrangements — two pins equidistant on opposite sides of the center — the swap can cause a small visible pop.

A stable tiebreaker (such as a hash of the event ID) would dampen this, at the cost of slightly less responsive ordering. The current code does not implement a tiebreaker; add one if the popping becomes user-visible.

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

where base_size_i comes from the greedy solver, and proximity_factor_i depends only on the pin's screen position.

> visual_lift_i  =  smooth_ramp(rendered_size_i)  ×  native_canvas_half_height

where the smooth ramp maps the rendered size onto [0, 1] over the configured threshold range.

The symbol layer reads rendered_size_i as `icon-size` and (0, visual_lift_i) as `icon-offset`. Mapbox handles the rendering: positions, scaling, the offset multiplied by `icon-size` at draw time.

## 10. Edge cases

### A single, isolated pin centered on screen

The greedy order has just one entry. The position cap at the center is loose. The candidate cap reduces to the absolute maximum. The proximity factor is 1. Final rendered size equals the absolute maximum. The icon fills ~80% of the smaller viewport dimension. The anchor lift is at full, so the icon is centered on the coord.

### A single pin at the corner of the viewport

Position cap is at or near zero (the pin is at an edge). Proximity factor is at the floor (the pin is far from center). The base size collapses to the minimum size; the rendered size is minimum_size × floor. The icon is small and barely visible. This is intentional — the pin is barely on-screen; magnifying it would be misleading.

### Two pins, both at screen center

Pathological but possible during dense thinning glitches. Both pins have proximity factor 1. The greedy order is arbitrary. One pin is sized first to the absolute maximum; the second is constrained to a tiny size (or the minimum floor) by the pairwise constraint. Visually: one big icon, one almost-invisible icon directly underneath. Acceptable degenerate behavior — the thinning step is supposed to prevent this configuration, so seeing it indicates a thinning bug rather than a sizing bug.

### Two pins at equal distance from the center, on opposite sides

Their proximity factors are equal. The greedy order is determined by whatever tiebreaker the sort uses (currently none — order is whatever the sort algorithm produces for equal keys). The "winner" gets the larger size. As the user pans, the order can flip and the size assignment swaps. With current code, this produces a brief visible pop. A stable tiebreaker would prevent this.

### A dense cluster of many pins

The greedy walk produces a clear hierarchy: the centermost pin is at full size; each subsequent pin is shrunk by the prior pin's footprint. In a tight cluster, all pins beyond the first few converge to the minimum size. Visually: one dominant icon and a halo of tiny ones. This is the intended "focus" effect.

### Panning an icon from screen center to the edge

Proximity factor decreases smoothly via the smoothstep curve. Position cap decreases smoothly as the pin nears the edge. The greedy order may re-shuffle when the pin's proximity drops below another pin's. The icon's size decreases smoothly throughout. No pop.

### Zooming in or out

The thinned set is recomputed when the gesture settles, not continuously. During the zoom gesture, the same set of pins is visible, and they re-size continuously. When the gesture ends, the visible set may change (more pins at high zoom, fewer at low zoom). On the next frame, the greedy solver runs over the new set; new pins are sized fresh.

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
- **The center pin never reaches max size when a neighbor is on-screen.** The solver is being run as a symmetric fixed-point instead of a greedy walk. Switch to the priority-ordered greedy assignment.
- **Magnification feels too aggressive on small pans.** The proximity factor's curve is linear or too steep near zero. Use smoothstep (or a higher-order ease) so the factor is flat near the center.
- **The icon pops visibly as it crosses some size threshold.** The anchor handling is switching `icon-anchor` discretely instead of ramping the offset continuously. Use the continuous offset.
- **Two equidistant pins swap sizes mid-pan.** The greedy sort has no stable tiebreaker. Add a hash-based one.
- **The location dot/stem is back at the bottom of the artwork and drifts as the icon grows.** See Section 8.

## 15. Things this system deliberately does not do

- It does not use Mapbox's built-in symbol collision detection. The layer is configured with collision allowed and placement ignored, because the JavaScript-side overlap solver fully owns the no-overlap invariant.
- It does not animate sizes with CSS or DOM transitions. Icons are sprites in a WebGL symbol layer; there is no DOM per icon.
- It does not consider event "importance" or rank for sizing. Importance affects which events are visible (the thinning step), but once an event is visible, sizing depends only on its current screen position relative to other visible icons. A high-importance event off in the corner is the same size as a low-importance one in the corner.
- It does not cache projected positions between frames. Every frame projects from scratch; this is cheap and avoids stale-projection bugs.

## 16. Open trade-offs left in place

- **No stable tiebreaker in the proximity sort.** Two pins at near-identical distance from center can swap order during pan; in rare cases this is visible.
- **Small icons near the top edge can clip a few pixels off-screen.** A consequence of the symmetric position cap; deemed acceptable because the proximity factor shrinks edge pins anyway, bounding the excursion.
- **No "importance"-weighted sizing.** A future product call may want the center icon's importance to factor into how aggressively it dominates. Currently importance only affects visibility.
- **Greedy is order-dependent, not globally optimal.** For pathological cluster geometries, the greedy walk can produce sizes that a globally optimal solver would do differently. Not a problem in practice for the visible-pin counts we deal with.
