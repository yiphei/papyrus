"""Event source: Partiful explore page.

Partiful is a Next.js SPA whose `/explore/<region>` page server-renders a
`__NEXT_DATA__` JSON blob containing fully-structured event objects (title,
ISO start/end, timezone, description, address) under `pageProps.feedItems`
and `pageProps.sections[].items`. We fetch that page once, merge both
lists, dedupe by event id, and skip search + LLM extraction entirely.
Coordinates are not embedded, so we still pass addresses through the
geocoder before emitting Events.
"""
from __future__ import annotations

import hashlib
import json
import logging
import re
from datetime import datetime, timezone
from typing import Any, ClassVar

import httpx

from ...geocoding import Geocoder, NominatimGeocoder
from ..models import (
    Event,
    EventCategory,
    EventQuery,
    EventStatus,
    LocationPrecision,
    Region,
)

logger = logging.getLogger(__name__)


_NEXT_DATA_RE = re.compile(
    r'<script id="__NEXT_DATA__"[^>]*>(.*?)</script>', re.DOTALL
)

# Map `near` hint to Partiful's region slug. The explore page only exists
# for a known set of slugs; anything else falls back to SF.
_REGION_SLUGS: tuple[tuple[tuple[str, ...], str], ...] = (
    (("san francisco", "sf", "bay area"), "SF"),
    (("new york", "nyc", "new york city"), "NYC"),
    (("los angeles", "la"), "LA"),
)

_CATEGORY_KEYWORDS: tuple[tuple[EventCategory, tuple[str, ...]], ...] = (
    (EventCategory.comedy, ("comedy", "stand-up", "standup", "open mic")),
    (EventCategory.film, ("screening", "film festival", "movie night", "cinema")),
    (EventCategory.concert, ("concert", "live music", "dj set", " plays ", "show w/")),
    (EventCategory.exhibition, ("gallery", "exhibition", "art show", "open studios")),
    (EventCategory.festival, ("festival", "fest ")),
    (
        EventCategory.tech,
        (
            "ai ", " ai", "a.i.", "ml ", " ml", "llm", "llms", "agent", "agents",
            "agentic", "agi", "gpt", "claude", "openai", "anthropic",
            "hackathon", "hack night", "hack day",
            "web3", "crypto", "blockchain", "nft", "dao", "defi",
            "founder", "founders", "startup", "startups", "yc ", "y combinator",
            "demo day", "saas", "b2b", "vc ", " vc",
            "developer", "developers", " dev ", " devs ",
            "engineering", "engineer", "engineers",
            "coding", "code ", "programming", "vibe coding",
            "python", "javascript", "typescript", "rust", "golang",
            "data science", "infra", "devtools", "open source",
            "techweek", "tech week",
        ),
    ),
)


def _region_slug(near: str | None) -> str:
    if not near:
        return "SF"
    low = near.lower()
    for keys, slug in _REGION_SLUGS:
        if any(k in low for k in keys):
            return slug
    return "SF"


def _classify(name: str) -> EventCategory:
    low = name.lower()
    for cat, kws in _CATEGORY_KEYWORDS:
        if any(k in low for k in kws):
            return cat
    return EventCategory.community


def _fingerprint(event_id: str) -> str:
    return hashlib.sha1(event_id.encode("utf-8")).hexdigest()[:16]


def _parse_iso(s: Any) -> datetime | None:
    if not isinstance(s, str):
        return None
    try:
        dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
    except ValueError:
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def _in_bbox(lat: float, lng: float, bbox: tuple[float, float, float, float]) -> bool:
    s, w, n, e = bbox
    return s <= lat <= n and w <= lng <= e


def _in_window(starts_at: datetime, after: datetime | None, before: datetime | None) -> bool:
    if after and starts_at < after:
        return False
    if before and starts_at >= before:
        return False
    return True


def _image_url(image: Any) -> str | None:
    if not isinstance(image, dict):
        return None
    up = image.get("upload") or {}
    return up.get("url") or None


def _address_lines(loc: dict[str, Any]) -> list[str]:
    mi = loc.get("mapsInfo") or {}
    lines = mi.get("addressLines") or loc.get("displayAddressLines") or []
    return [str(x) for x in lines if x]


def _approximate_location(loc: dict[str, Any]) -> str:
    mi = loc.get("mapsInfo") or {}
    return str(mi.get("approximateLocation") or "")


class PartifulEventSource:
    """Direct integration with Partiful's explore page.

    Skips Tavily + LLM by parsing the SSR-rendered `__NEXT_DATA__` JSON.
    Addresses are geocoded via the injected `Geocoder` (defaults to
    Nominatim) before events are emitted, so this source is
    geocoder-rate-limit-bound (~1 req/sec per address).
    """

    id: ClassVar[str] = "partiful"
    name: ClassVar[str] = "Partiful"
    coverage: ClassVar[Region | None] = None  # global; region picked by `near`

    def __init__(
        self,
        timeout_s: float = 15.0,
        geocoder: Geocoder | None = None,
    ) -> None:
        self._timeout_s = timeout_s
        self._geocoder: Geocoder = geocoder or NominatimGeocoder()

    async def search(self, query: EventQuery) -> list[Event]:
        slug = _region_slug(query.near)
        url = f"https://partiful.com/explore/{slug}"
        async with httpx.AsyncClient(
            timeout=self._timeout_s,
            follow_redirects=True,
            headers={"User-Agent": "Mozilla/5.0 (papyrus)"},
        ) as client:
            try:
                resp = await client.get(url)
                resp.raise_for_status()
            except httpx.HTTPError as exc:
                logger.warning("partiful explore fetch failed: %s", exc)
                return []
            html = resp.text

        raw = self._collect_raw(html)
        logger.info("partiful: %d raw events on %s", len(raw), url)

        events: list[Event] = []
        for ev_raw in raw:
            ev = await self._promote(ev_raw, query)
            if ev is not None:
                events.append(ev)
        logger.info(
            "partiful: %d raw -> %d kept after window/bbox/geocode",
            len(raw), len(events),
        )
        return events

    def _collect_raw(self, html: str) -> list[dict[str, Any]]:
        m = _NEXT_DATA_RE.search(html)
        if not m:
            logger.warning("partiful: no __NEXT_DATA__ block found")
            return []
        try:
            data = json.loads(m.group(1))
        except json.JSONDecodeError as exc:
            logger.warning("partiful: __NEXT_DATA__ parse failed: %s", exc)
            return []
        pp = (data.get("props") or {}).get("pageProps") or {}

        merged: dict[str, dict[str, Any]] = {}
        for item in pp.get("feedItems") or []:
            ev = (item or {}).get("event") or {}
            ev_id = ev.get("id")
            if ev_id and ev_id not in merged:
                merged[ev_id] = ev
        for section in pp.get("sections") or []:
            for item in section.get("items") or []:
                ev = (item or {}).get("event") or {}
                ev_id = ev.get("id")
                if ev_id and ev_id not in merged:
                    merged[ev_id] = ev
        return list(merged.values())

    async def _promote(
        self, ev: dict[str, Any], query: EventQuery
    ) -> Event | None:
        if not ev.get("isPublic"):
            return None
        if ev.get("status") != "PUBLISHED":
            return None
        starts_at = _parse_iso(ev.get("startDate"))
        if starts_at is None:
            return None
        if not _in_window(starts_at, query.starts_after, query.starts_before):
            return None

        loc = ev.get("locationInfo") or {}
        if loc.get("type") != "structured":
            return None
        approx = _approximate_location(loc).lower()
        if query.near and approx and not _matches_near(approx, query.near):
            return None

        lines = _address_lines(loc)
        if not lines:
            return None
        address = ", ".join(lines)
        mi = loc.get("mapsInfo") or {}
        venue_name = mi.get("name") or None

        coords = await self._geocode(venue_name, address, query.near)
        if coords is None:
            logger.info(
                "partiful: dropping %r: geocode failed for %r / %r",
                ev.get("title"), venue_name, address,
            )
            return None
        lat, lng = coords
        if not _in_bbox(lat, lng, query.bbox):
            return None

        ev_id = str(ev.get("id") or "")
        return Event(
            source_id=PartifulEventSource.id,
            source_event_id=_fingerprint(ev_id),
            title=str(ev.get("title") or "(untitled)"),
            description=ev.get("description") or None,
            category=_classify(str(ev.get("title") or "")),
            tags=[],
            starts_at=starts_at,
            ends_at=_parse_iso(ev.get("endDate")),
            timezone=ev.get("timezone"),
            lat=lat,
            lng=lng,
            location_precision=LocationPrecision.venue if venue_name else LocationPrecision.point,
            venue_name=venue_name,
            address=address,
            url=f"https://partiful.com/e/{ev_id}" if ev_id else None,
            image_url=_image_url(ev.get("image")),
            price=None,
            status=EventStatus.scheduled,
        )

    async def _geocode(
        self, venue: str | None, address: str | None, near: str | None
    ) -> tuple[float, float] | None:
        candidates: list[str] = []
        if venue and address:
            candidates.append(f"{venue}, {address}")
        if address:
            candidates.append(address)
        if venue:
            candidates.append(f"{venue}, {near}" if near else venue)
        for q in candidates:
            coords = await self._geocoder.geocode(q)
            if coords is not None:
                return coords
        return None


def _matches_near(approx: str, near: str) -> bool:
    near_low = near.lower()
    # quick "is the event in the requested metro" check; we only filter out
    # obvious non-matches (e.g. Oakland event in an SF query) to save geocoder
    # round-trips, so we accept whenever either string contains the other.
    return near_low in approx or approx in near_low or _shares_token(approx, near_low)


def _shares_token(a: str, b: str) -> bool:
    a_tokens = {t for t in re.split(r"[ ,]+", a) if len(t) > 2}
    b_tokens = {t for t in re.split(r"[ ,]+", b) if len(t) > 2}
    return bool(a_tokens & b_tokens)
