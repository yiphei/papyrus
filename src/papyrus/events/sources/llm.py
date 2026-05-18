"""Event source: web search → LLM extraction → geocode.

Pipeline:
  1. SearchProvider returns top-N web results for a query string.
  2. Claude (with NO tools) extracts structured event records from the snippets.
  3. Geocoder turns each event's venue/address into lat/lng.

The LLM never browses or "decides" what to search for; the search is a single
deterministic API call. This trades agency for predictable latency.
"""
from __future__ import annotations

import hashlib
import logging
from datetime import datetime, timezone
from typing import Any, ClassVar

import anthropic
from pydantic import BaseModel, Field

from ...geocoding import Geocoder, NominatimGeocoder
from ...search import SearchProvider, SearchResult, TavilySearchProvider
from ..models import (
    Event,
    EventCategory,
    EventQuery,
    EventStatus,
    LocationPrecision,
    Region,
)

logger = logging.getLogger(__name__)


class _LLMEvent(BaseModel):
    """What we ask the model to emit per event. We deliberately do NOT ask
    for lat/lng -- geocoding venues/addresses inflates LLM latency a lot.
    A separate geocoder fills those in afterwards."""

    title: str
    description: str | None = None
    category: str
    tags: list[str] = Field(default_factory=list)
    starts_at: datetime
    ends_at: datetime | None = None
    timezone: str | None = None
    venue_name: str | None = None
    address: str | None = None
    url: str  # required as evidence; events without it are dropped
    image_url: str | None = None
    price: str | None = None


class _LLMResponse(BaseModel):
    events: list[_LLMEvent]


_EXTRACTOR_SYSTEM_PROMPT = """\
You extract structured event information from web search results.

A live event is something happening at a specific time and place that is not
a permanent fixture: farmers markets, craft fairs, festivals, concerts, sports
games, theater, comedy, political rallies, town halls, protests, limited-time
museum exhibitions, community events, parades, conferences.

For each search result that describes a specific live event with a known date,
emit ONE event record. SKIP results that:
- describe a venue, organization, or recurring program with no specific date
- are listing/index pages summarising many events without enough detail
- are clearly not events (news articles, blog posts about something else)

Use the search result's URL as the event url. Include venue_name and a street
address when present. Do NOT include lat/lng -- a downstream system geocodes
addresses for you.
"""


def _build_search_query(query: EventQuery) -> str:
    where = query.near or "this region"
    cats: list[str] = []
    if query.categories:
        cats = [c.value.replace("_", " ") for c in query.categories]
    head = " ".join(cats) if cats else "live events"
    parts = [f"{head} in {where}"]
    if query.text:
        parts.append(query.text)
    when = _time_window_phrase(query)
    if when:
        parts.append(when)
    return " ".join(parts)


def _time_window_phrase(query: EventQuery) -> str | None:
    if not query.starts_after and not query.starts_before:
        return "this week"
    if query.starts_after and query.starts_before:
        return (
            f"between {query.starts_after.date().isoformat()} "
            f"and {query.starts_before.date().isoformat()}"
        )
    if query.starts_after:
        return f"after {query.starts_after.date().isoformat()}"
    return f"before {query.starts_before.date().isoformat()}"


def _build_extractor_prompt(
    query: EventQuery, results: list[SearchResult]
) -> str:
    lines = [
        f"Extract live events near {query.near or 'the queried area'}.",
        f"Time window: {_time_window_phrase(query) or 'unspecified'}.",
        f"Return up to {query.limit} events.",
        "",
        "Search results:",
    ]
    for i, r in enumerate(results, 1):
        lines.append(f"[{i}] {r.title}")
        lines.append(f"    URL: {r.url}")
        if r.content:
            snippet = r.content.strip().replace("\n", " ")
            if len(snippet) > 600:
                snippet = snippet[:600] + "…"
            lines.append(f"    {snippet}")
        lines.append("")
    return "\n".join(lines)


def _fingerprint(title: str, starts_at: datetime, venue: str | None) -> str:
    norm = f"{title.strip().lower()}|{starts_at.isoformat()}|{(venue or '').strip().lower()}"
    return hashlib.sha1(norm.encode("utf-8")).hexdigest()[:16]


def _coerce_category(raw: str) -> EventCategory:
    try:
        return EventCategory(raw)
    except ValueError:
        return EventCategory.other


def _ensure_utc(dt: datetime) -> datetime:
    if dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def _extract_json_text(response: Any) -> str | None:
    for block in getattr(response, "content", []):
        text = getattr(block, "text", None)
        if text:
            return text
    return None


class LLMEventSource:
    """Search-then-extract event source.

    `SearchProvider` returns top-N web results; Claude (no tools) extracts
    structured events from the snippets; `Geocoder` resolves lat/lng.
    """

    id: ClassVar[str] = "llm"
    name: ClassVar[str] = "Web Search + LLM Extract"
    coverage: ClassVar[Region | None] = None  # global

    def __init__(
        self,
        client: anthropic.AsyncAnthropic | None = None,
        model: str = "claude-sonnet-4-6",
        max_tokens: int = 4096,
        request_timeout_s: float = 120.0,
        search_provider: SearchProvider | None = None,
        geocoder: Geocoder | None = None,
        search_k: int = 10,
    ) -> None:
        self._client = client or anthropic.AsyncAnthropic(timeout=request_timeout_s)
        self._model = model
        self._max_tokens = max_tokens
        self._search: SearchProvider = search_provider or TavilySearchProvider()
        self._geocoder: Geocoder = geocoder or NominatimGeocoder()
        self._search_k = search_k

    async def search(self, query: EventQuery) -> list[Event]:
        search_query = _build_search_query(query)
        logger.info("tavily search: %r (k=%d)", search_query, self._search_k)
        results = await self._search.search(search_query, k=self._search_k)
        if not results:
            return []

        response = await self._client.messages.create(
            model=self._model,
            max_tokens=self._max_tokens,
            system=_EXTRACTOR_SYSTEM_PROMPT,
            messages=[
                {"role": "user", "content": _build_extractor_prompt(query, results)}
            ],
            output_config={
                "format": {
                    "type": "json_schema",
                    "schema": anthropic.transform_schema(_LLMResponse),
                }
            },
        )
        raw = _extract_json_text(response)
        if not raw:
            return []
        parsed = _LLMResponse.model_validate_json(raw)

        events: list[Event] = []
        for item in parsed.events:
            ev = await self._promote(item, query.near)
            if ev is None:
                continue
            events.append(ev)
        return events

    async def _promote(self, item: _LLMEvent, near_hint: str | None) -> Event | None:
        coords = await self._geocode_item(item, near_hint)
        if coords is None:
            logger.info("dropping event %r: could not geocode %r / %r",
                        item.title, item.venue_name, item.address)
            return None
        lat, lng = coords
        starts_at = _ensure_utc(item.starts_at)
        return Event(
            source_id=LLMEventSource.id,
            source_event_id=_fingerprint(item.title, starts_at, item.venue_name),
            title=item.title,
            description=item.description,
            category=_coerce_category(item.category),
            tags=item.tags,
            starts_at=starts_at,
            ends_at=_ensure_utc(item.ends_at) if item.ends_at else None,
            timezone=item.timezone,
            lat=lat,
            lng=lng,
            location_precision=LocationPrecision.venue if item.venue_name else LocationPrecision.point,
            venue_name=item.venue_name,
            address=item.address,
            url=item.url,
            image_url=item.image_url,
            price=item.price,
            status=EventStatus.scheduled,
        )

    async def _geocode_item(
        self, item: _LLMEvent, near_hint: str | None
    ) -> tuple[float, float] | None:
        # try the most-specific signal first, then fall back
        candidates: list[str] = []
        if item.venue_name and item.address:
            candidates.append(f"{item.venue_name}, {item.address}")
        if item.address:
            candidates.append(item.address)
        if item.venue_name:
            base = item.venue_name
            if near_hint:
                candidates.append(f"{base}, {near_hint}")
            candidates.append(base)
        for q in candidates:
            coords = await self._geocoder.geocode(q)
            if coords is not None:
                return coords
        return None
