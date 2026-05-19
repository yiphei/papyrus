"""Event source: ESPN public schedule API for SF home games.

Two SF-proper venues are covered today:
- Oracle Park (San Francisco Giants, MLB)
- Chase Center (Golden State Warriors, NBA)

ESPN exposes per-team schedules as JSON at
  https://site.api.espn.com/apis/site/v2/sports/{sport}/{league}/teams/{slug}/schedule
which returns recent + upcoming games for the team's current/next season,
with pre-resolved venue, opponents, status, and a gamecast URL. We pick
home games only, inside the query window, whose status indicates they
haven't already happened.
"""
from __future__ import annotations

import asyncio
import hashlib
import logging
from dataclasses import dataclass
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

_SCHEDULE_URL = (
    "https://site.api.espn.com/apis/site/v2/sports/{sport}/{league}"
    "/teams/{slug}/schedule"
)

# Status names ESPN uses for games yet to be played. STATUS_FINAL, _CANCELED,
# _POSTPONED, _IN_PROGRESS etc are excluded.
_LIVE_STATUSES = frozenset({"STATUS_SCHEDULED", "STATUS_FIRST_PITCH_PENDING"})


@dataclass(frozen=True)
class _TeamSpec:
    sport: str
    league: str
    slug: str
    display: str  # ESPN's competitor.team.displayName for the home team
    venue: str
    lat: float
    lng: float


_TEAMS: tuple[_TeamSpec, ...] = (
    _TeamSpec("baseball", "mlb", "sf", "San Francisco Giants",
              "Oracle Park", 37.7786, -122.3893),
    _TeamSpec("basketball", "nba", "gs", "Golden State Warriors",
              "Chase Center", 37.7680, -122.3877),
)


def _fingerprint(espn_event_id: str) -> str:
    return hashlib.sha1(espn_event_id.encode("utf-8")).hexdigest()[:16]


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


def _in_window(dt: datetime, after: datetime | None, before: datetime | None) -> bool:
    if after and dt < after:
        return False
    if before and dt >= before:
        return False
    return True


def _gamecast_url(ev: dict[str, Any]) -> str | None:
    for link in ev.get("links") or []:
        if "event" in (link.get("rel") or []) and link.get("href"):
            return link["href"]
    return None


class EspnSportsSource:
    """Direct ESPN schedule fetch for SF-proper pro sports."""

    id: ClassVar[str] = "espn-sports"
    name: ClassVar[str] = "ESPN Sports"
    coverage: ClassVar[Region | None] = None  # SF teams only; bbox filter does the work

    def __init__(self, timeout_s: float = 15.0) -> None:
        self._timeout_s = timeout_s

    async def search(self, query: EventQuery) -> list[Event]:
        async with httpx.AsyncClient(
            timeout=self._timeout_s, headers={"User-Agent": "Mozilla/5.0"}
        ) as client:
            per_team = await asyncio.gather(
                *(self._fetch_team(client, spec, query) for spec in _TEAMS),
                return_exceptions=True,
            )
        events: list[Event] = []
        for spec, result in zip(_TEAMS, per_team):
            if isinstance(result, BaseException):
                logger.warning("espn-sports: %s fetch failed: %r", spec.slug, result)
                continue
            events.extend(result)
        logger.info("espn-sports: %d home games kept across %d teams",
                    len(events), len(_TEAMS))
        return events

    async def _fetch_team(
        self, client: httpx.AsyncClient, spec: _TeamSpec, query: EventQuery,
    ) -> list[Event]:
        url = _SCHEDULE_URL.format(sport=spec.sport, league=spec.league, slug=spec.slug)
        r = await client.get(url)
        r.raise_for_status()
        payload = r.json()
        out: list[Event] = []
        for ev in payload.get("events") or []:
            promoted = self._promote(ev, spec, query)
            if promoted is not None:
                out.append(promoted)
        logger.info("espn-sports: %s -> %d/%d home games in window",
                    spec.slug, len(out), len(payload.get("events") or []))
        return out

    def _promote(
        self, ev: dict[str, Any], spec: _TeamSpec, query: EventQuery,
    ) -> Event | None:
        comp = (ev.get("competitions") or [{}])[0]
        status_name = ((comp.get("status") or {}).get("type") or {}).get("name")
        if status_name not in _LIVE_STATUSES:
            return None
        # Home team check: only keep games where this spec's team is the
        # home side, so the venue (and our lat/lng) is correct.
        home_team_name: str | None = None
        for c in comp.get("competitors") or []:
            if c.get("homeAway") == "home":
                home_team_name = ((c.get("team") or {}).get("displayName")) or None
                break
        if home_team_name != spec.display:
            return None
        starts_at = _parse_iso(ev.get("date"))
        if starts_at is None:
            return None
        if not _in_window(starts_at, query.starts_after, query.starts_before):
            return None
        if not _in_bbox(spec.lat, spec.lng, query.bbox):
            return None
        espn_id = str(ev.get("id") or "")
        if not espn_id:
            return None
        venue_obj = comp.get("venue") or {}
        address = venue_obj.get("address") or {}
        city = address.get("city")
        addr_str = f"{venue_obj.get('fullName') or spec.venue}"
        if city:
            addr_str = f"{addr_str}, {city}"
        return Event(
            source_id=EspnSportsSource.id,
            source_event_id=_fingerprint(espn_id),
            title=ev.get("name") or f"{spec.display} home game",
            description=None,
            category=EventCategory.sports,
            tags=[],
            starts_at=starts_at,
            ends_at=None,
            timezone=None,
            lat=spec.lat,
            lng=spec.lng,
            location_precision=LocationPrecision.venue,
            venue_name=venue_obj.get("fullName") or spec.venue,
            address=addr_str,
            url=_gamecast_url(ev),
            image_url=None,
            price=None,
            status=EventStatus.scheduled,
        )

