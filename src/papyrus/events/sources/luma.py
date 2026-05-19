"""Event source: Luma discover API.

Luma's public discover endpoint returns structured event objects with
pre-resolved coordinates and street addresses, so we skip the
search-then-LLM pipeline entirely for this source.

Endpoint: https://api.lu.ma/discover/get-paginated-events
"""
from __future__ import annotations

import hashlib
import logging
from datetime import datetime, timezone
from typing import Any, ClassVar

import httpx

from ..models import (
    Event,
    EventCategory,
    EventQuery,
    EventStatus,
    LocationPrecision,
    Region,
)

logger = logging.getLogger(__name__)


_ENDPOINT = "https://api.lu.ma/discover/get-paginated-events"

# Lightweight keyword -> category map. Luma events are mostly tech meetups,
# socials, workshops; we tag the obvious genre fits, then split out tech
# industry events, and fall back to community for the rest.
# Order matters: more-specific buckets are matched first.
_CATEGORY_KEYWORDS: tuple[tuple[EventCategory, tuple[str, ...]], ...] = (
    (EventCategory.comedy, ("comedy", "stand-up", "standup", "open mic")),
    (EventCategory.film, ("screening", "film festival", "movie night", "cinema")),
    (EventCategory.concert, ("concert", "live music", "dj set", "show w/")),
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
            "meetup", "office hours", "techweek", "tech week",
        ),
    ),
)


def _classify(name: str) -> EventCategory:
    low = name.lower()
    for cat, kws in _CATEGORY_KEYWORDS:
        if any(k in low for k in kws):
            return cat
    return EventCategory.community


def _fingerprint(api_id: str) -> str:
    return hashlib.sha1(api_id.encode("utf-8")).hexdigest()[:16]


def _parse_iso(s: str | None) -> datetime | None:
    if not s:
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


class LumaEventSource:
    """Direct integration with Luma's public discover API.

    Bypasses the search + LLM extractor because Luma's HTML is JS-rendered
    and unscrapeable, but the JSON discover endpoint returns events with
    coordinates, full addresses, timezones and cover images already
    structured.
    """

    id: ClassVar[str] = "luma"
    name: ClassVar[str] = "Luma"
    coverage: ClassVar[Region | None] = None  # global

    def __init__(
        self,
        timeout_s: float = 15.0,
        max_pages: int = 3,
        period: str = "this_week",
    ) -> None:
        self._timeout_s = timeout_s
        self._max_pages = max_pages
        self._period = period

    async def search(self, query: EventQuery) -> list[Event]:
        search_query = (query.near or "San Francisco").lower()
        async with httpx.AsyncClient(timeout=self._timeout_s) as client:
            entries = await self._fetch_all(client, search_query)
        events: list[Event] = []
        for entry in entries:
            ev = self._promote(entry, query)
            if ev is not None:
                events.append(ev)
        logger.info(
            "luma: %d entries fetched, %d kept after bbox/window filter",
            len(entries), len(events),
        )
        return events

    async def _fetch_all(
        self, client: httpx.AsyncClient, search_query: str
    ) -> list[dict[str, Any]]:
        params: dict[str, str] = {"period": self._period, "search_query": search_query}
        all_entries: list[dict[str, Any]] = []
        for _ in range(self._max_pages):
            try:
                resp = await client.get(
                    _ENDPOINT, params=params, headers={"Accept": "application/json"}
                )
                resp.raise_for_status()
            except httpx.HTTPError as exc:
                logger.warning("luma discover fetch failed: %s", exc)
                break
            data = resp.json()
            all_entries.extend(data.get("entries", []))
            if not data.get("has_more") or not data.get("next_cursor"):
                break
            params = dict(params)
            params["pagination_cursor"] = data["next_cursor"]
        return all_entries

    def _promote(self, entry: dict[str, Any], query: EventQuery) -> Event | None:
        ev = entry.get("event") or {}
        if ev.get("location_type") != "offline":
            return None
        coord = ev.get("coordinate") or {}
        lat, lng = coord.get("latitude"), coord.get("longitude")
        if lat is None or lng is None:
            return None
        if not _in_bbox(lat, lng, query.bbox):
            return None
        starts_at = _parse_iso(ev.get("start_at"))
        if starts_at is None:
            return None
        if not _in_window(starts_at, query.starts_after, query.starts_before):
            return None
        api_id = ev.get("api_id") or ""
        slug = ev.get("url") or ""
        gai = ev.get("geo_address_info") or {}
        return Event(
            source_id=LumaEventSource.id,
            source_event_id=_fingerprint(api_id) if api_id else _fingerprint(slug),
            title=ev.get("name") or "(untitled)",
            description=None,
            category=_classify(ev.get("name") or ""),
            tags=[],
            starts_at=starts_at,
            ends_at=_parse_iso(ev.get("end_at")),
            timezone=ev.get("timezone"),
            lat=float(lat),
            lng=float(lng),
            location_precision=LocationPrecision.venue if gai.get("address") else LocationPrecision.point,
            venue_name=gai.get("address") or None,
            address=gai.get("full_address") or None,
            url=f"https://lu.ma/{slug}" if slug else None,
            image_url=ev.get("cover_url") or None,
            price=None,
            status=EventStatus.scheduled,
        )
