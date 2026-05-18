# Papyrus

## Context

I want to build a map app optimized for rendering and searching live events, which google maps doesnt do well. A live event is anything that is not a regular occurrence OR perhaps is a regular occurrence but does not have a first-class map rendering. Some examples of live events (non-exhaustive list):

- farmers market
- entertainment events (sports, concerts, etc.)
- political events
- fair (e.g. craft fair)
- promotional events. For instance, a museum itself is not a live event, but a limited time special exhibition inside the museum is a live event
- user-generated content. For instance, an user may list a custom live-event (a birthday party) on the map

Each live event will be rendered as a first-class map asset, so akin to a landmark or point of interest (unlike google maps which may only render it as a geotagged pin, if at all). The rendering can either be a 2d image, a 3d static asset, 2d animation, or a 3d animation. Furthermore, unlike traditional map point of interests, the placement may be unconventional in the sense that it is may not be localized to a specific location. For instance, a chinese new year parade may span multiple neighborhoods, so it needs to be rendered across the neighborhoods in. When you click on the live event, it will reveal more information about the live event, similar to google maps.

I am just looking to build a working MVP quickly that i can demo to friends and family (locally). The MVP should have:

- mapbox map app
- layer live events on the map with custom UI/rendering
- hierarchical zoom
- search