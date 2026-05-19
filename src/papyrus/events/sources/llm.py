"""Event source: web search → LLM extraction → geocode.

Pipeline:
  1. SearchProvider returns top-N web results for a query string.
  2. Claude (with NO tools) extracts structured event records from the snippets.
  3. Geocoder turns each event's venue/address into lat/lng.

The LLM never browses or "decides" what to search for; the search is a single
deterministic API call. This trades agency for predictable latency.
"""
from __future__ import annotations

import asyncio
import hashlib
import logging
from datetime import datetime, timedelta, timezone
from typing import Any, ClassVar
from urllib.parse import urlparse

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
    category: EventCategory
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

LISTING PAGES ARE YOUR PRIMARY SOURCE OF EVENTS. Many of the results you
receive are listing pages, daily/weekly/monthly calendars, venue schedules,
"what to do this weekend" articles, or platform discovery pages (Eventbrite,
Luma, Funcheap, Partiful, Ticketmaster, DoTheBay, Songkick, etc.). These
pages typically embed dozens of dated event entries. WORK THROUGH THE PAGE
TOP TO BOTTOM and emit ONE RECORD FOR EACH dated entry that satisfies the
rules. Do not pick favorites; do not summarize; do not stop after a few.
If you only emit a handful of events from a page that clearly contains many
dated entries, you are doing it wrong.

For every event you emit, ALL of the following must be true:
- it has a SPECIFIC start date and time (not a date range alone, not "TBA").
  If only a date is given but no time, infer a sensible default for the
  category (concerts 19:00 or 20:00, theater 19:30, markets 09:00, sports
  per typical league start times) and emit it.
- the start time falls inside the requested time window (see user message).
  If you cannot determine an exact start time inside the window, SKIP the
  event; do NOT emit events that begin before the window starts or after it
  ends.
- it has a SPECIFIC venue_name (e.g. "DNA Lounge", "Oracle Park", "Civic
  Center Plaza"). SKIP the event if you cannot identify a real named venue.
- include a street address in `address` only if explicitly stated; otherwise
  leave it null -- a downstream geocoder will resolve venue_name.

TWO EXPLICIT EXCEPTIONS to the "specific time" rule -- emit these even
though they span ranges or repeat:

1. EXHIBITIONS (museum / gallery shows) with a stated multi-day run.
   If the run overlaps the requested window, emit ONE record. Use the
   first day of overlap (window start, or the show's opening day if it
   opens inside the window) at the venue's typical opening hour
   (default 10:00 local). Put the full run dates in `description` if
   stated. Set `ends_at` to the closing date end-of-day if known.

2. RECURRING WEEKLY EVENTS that name an explicit weekday + time
   (e.g. "Saturdays 9am-2pm", "every Wednesday 4-8pm"). This covers
   farmers markets, weekly food halls, weekly community classes,
   weekly open mics. Emit ONE record for EACH occurrence whose start
   time lands inside the requested window. Use the stated start time
   on the matching weekday's actual calendar date.

   IF NO STATED WEEKDAY FALLS INSIDE THE REQUESTED WINDOW, SKIP THE
   EVENT ENTIRELY. Do NOT stamp it with the window's start or end
   date, and do NOT shift it to a different weekday. A "Saturday
   farmers market" inside a Tuesday-Thursday window must be omitted,
   not relabeled as Tuesday or Thursday.

SKIP entirely:
- results with literally zero dated event entries (pure navigation, sitemap
  dumps, broken pages). If the page lists ANY dated events in our window,
  process it -- do not bail because the page also has navigation chrome,
  ads, or out-of-window content.
- recurring programs with no explicit weekday + time pattern (see
  exception 2 above for what IS allowed)
- news articles or blog posts that only discuss past events

For the event `url`, prefer the per-event ticketing/landing URL when the
listing-page body contains one (e.g. a Ticketmaster, Eventbrite, Luma, or
Partiful link for that specific event). Otherwise fall back to the source
search result URL. Do NOT invent URLs.
Do NOT include lat/lng -- a downstream system geocodes for you.

CATEGORY ASSIGNMENT. Pick the most specific category that fits. Guidance:
- `concert`: ticketed live music, DJ sets, symphony, opera, residencies.
- `sports`: pro/college/amateur games (MLB, NBA, NHL, MLS, NWSL, college),
  marathons, regattas, fight nights.
- `theater`: plays, musicals, dance performances, ballet.
- `comedy`: stand-up, improv, comedy showcases, open mics.
- `film`: screenings, festivals, retrospectives, indie premieres.
- `farmers_market`: weekly farmers markets, food halls' market days.
- `festival`: multi-day celebrations (music, food, cultural, pride).
- `fair`: craft fairs, holiday fairs, school fairs, street fairs.
- `exhibition`: limited-run museum or gallery shows (not the museum's
  permanent collection).
- `political`: rallies, protests, town halls, candidate forums, civic
  hearings, party committee meetings.
- `tech`: tech industry events. Hackathons, demo days, AI/ML/LLM/agents
  meetups, web3/crypto/blockchain events, founder/startup mixers, YC and
  VC events, developer/engineering meetups, SaaS/B2B/devtools talks,
  programming-language groups (Python/Rust/JS/Go), data science meetups.
  If the event is a tech meetup it is `tech`, NOT `community`.
- `community`: civic and neighborhood gatherings unrelated to tech --
  mutual aid, block parties, volunteer days, religious community events,
  neighborhood association meetings, language exchanges, run/book/cycle
  clubs, parenting groups.
- `other`: only when nothing above fits. Avoid this when possible.
"""


def _build_search_query(query: EventQuery) -> str:
    where = query.near or "this region"
    cats: list[str] = []
    if query.categories:
        if len(query.categories) == 1:
            cats = [_CATEGORY_QUERY_HEAD.get(
                query.categories[0], query.categories[0].value.replace("_", " ")
            )]
        else:
            cats = [c.value.replace("_", " ") for c in query.categories]
    head = " ".join(cats) if cats else "live events"
    parts = [f"{head} in {where}"]
    if query.text:
        parts.append(query.text)
    when = _time_window_phrase(query)
    if when:
        parts.append(when)
    return " ".join(parts)


# Search-friendly phrasings for single-category queries. Bare category names
# like "community" or "political" produce noisy Tavily results; richer
# multi-word heads surface the right kind of listing pages.
_CATEGORY_QUERY_HEAD: dict[EventCategory, str] = {
    EventCategory.concert: "concerts live music",
    EventCategory.sports: "sports games tickets",
    EventCategory.theater: "theater plays musicals",
    EventCategory.comedy: "comedy stand-up shows",
    EventCategory.film: "film screenings",
    EventCategory.farmers_market: "farmers market",
    EventCategory.festival: "festival",
    EventCategory.fair: "craft fair street fair",
    EventCategory.exhibition: "museum gallery exhibition",
    EventCategory.political: "political rally protest town hall",
    EventCategory.community: "community events neighborhood",
}


# Category buckets used for multi-query fan-out when the caller did not
# specify categories. Each bucket becomes a separate Tavily search; results
# are round-robin merged so no single source/category dominates the prompt.
#
# We deliberately give each under-served category its own bucket so a
# narrow Tavily query like "sports games in San Francisco ..." surfaces
# venue-specific listings instead of being diluted by a multi-category
# bag-of-keywords. `tech` is intentionally absent: the Luma direct source
# already supplies more than enough tech events.
_FANOUT_BUCKETS: tuple[tuple[EventCategory, ...], ...] = (
    (EventCategory.concert,),
    (EventCategory.comedy,),
    (EventCategory.film,),
    (EventCategory.theater,),
    (EventCategory.sports,),
    (EventCategory.exhibition,),
    (EventCategory.farmers_market,),
    (EventCategory.festival,),
    (EventCategory.fair,),
    (EventCategory.political,),
    (EventCategory.community,),
)


# Site-restricted fan-out buckets. Each entry is (label, domains, template).
# The template is rendered against {near}, {when}, and {date_natural}.
# Tavily ranks by keyword match against page text; natural date phrases
# like "May 19 2026" surface date-filtered discovery pages and per-event
# URL slugs more reliably than bracketed range phrases.
_FANOUT_SITES: tuple[tuple[str, tuple[str, ...], str], ...] = (
    (
        "eventbrite",
        ("eventbrite.com",),
        "concerts comedy theater tickets {near} events {date_natural}",
    ),
    # luma is served by a dedicated API source (see sources/luma.py); its
    # HTML is JS-rendered, so Tavily scrapes return only page chrome.
    (
        "funcheap",
        ("funcheap.com", "sf.funcheap.com"),
        "farmers market fair exhibition free events {near} {when}",
    ),
    # partiful is served by a dedicated source (see sources/partiful.py)
    # that parses the SSR-rendered __NEXT_DATA__ blob on the explore page.
    (
        "ticketmaster",
        ("ticketmaster.com",),
        "sports theater concerts tickets {near} {date_natural}",
    ),
    (
        "dothebay",
        ("dothebay.com",),
        "theater exhibition rally protest farmers market {near} {date_natural}",
    ),
)


def _natural_date_phrase(query: EventQuery) -> str:
    """Tavily-friendly date phrase like "May 19 2026". Falls back to a
    generic time hint if no anchor date is set."""
    anchor = query.starts_after or query.starts_before
    if anchor is None:
        return "this week"
    months = ["January", "February", "March", "April", "May", "June",
             "July", "August", "September", "October", "November", "December"]
    d = anchor.date()
    return f"{months[d.month - 1]} {d.day} {d.year}"


def _build_site_search_query(query: EventQuery, template: str) -> str:
    where = query.near or "this region"
    when = _time_window_phrase(query) or ""
    date_natural = _natural_date_phrase(query)
    rendered = template.format(near=where, when=when, date_natural=date_natural)
    if query.text:
        rendered = f"{rendered} {query.text}"
    return " ".join(rendered.split())


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


def _window_date_needles(query: EventQuery) -> list[str]:
    """Day-stamped substrings likely to appear on a page that lists events
    inside our query window. Used to bias truncation toward the relevant
    slice of dense listing pages."""
    needles: list[str] = []
    start = query.starts_after.date() if query.starts_after else None
    end = query.starts_before.date() if query.starts_before else None
    if start is None or end is None:
        return needles
    months_full = ["January", "February", "March", "April", "May", "June",
                   "July", "August", "September", "October", "November", "December"]
    months_abbr = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
                   "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
    d = start
    # cap to avoid pathological ranges
    for _ in range(31):
        needles.append(d.isoformat())                       # 2026-05-19
        needles.append(f"{d.month}/{d.day}/{d.year}")       # 5/19/2026
        needles.append(f"{d.month}/{d.day}")                # 5/19
        needles.append(f"{months_full[d.month - 1]} {d.day}")   # May 19
        needles.append(f"{months_abbr[d.month - 1]} {d.day}")   # May 19 (abbr same)
        if d >= end:
            break
        d = d.fromordinal(d.toordinal() + 1)
    return needles


def _truncate_with_window_bias(
    body: str, max_chars: int, needles: list[str]
) -> str:
    """Truncate `body` to `max_chars`. If the body is longer and contains a
    date needle from our window, center the kept slice around the earliest
    needle hit so window-relevant content is preserved. Otherwise take the
    head as before."""
    if len(body) <= max_chars:
        return body
    hit = -1
    for n in needles:
        if not n:
            continue
        idx = body.find(n)
        if idx >= 0 and (hit < 0 or idx < hit):
            hit = idx
    if hit < 0:
        return body[:max_chars] + "…"
    head = max_chars // 4
    start = max(0, hit - head)
    end = start + max_chars
    if end > len(body):
        end = len(body)
        start = max(0, end - max_chars)
    prefix = "…" if start > 0 else ""
    suffix = "…" if end < len(body) else ""
    return prefix + body[start:end] + suffix


def _host(u: str) -> str:
    try:
        h = (urlparse(u).hostname or "").lower()
    except Exception:
        return ""
    return h[4:] if h.startswith("www.") else h


def _build_extractor_prompt(
    query: EventQuery,
    results: list[SearchResult],
    raw_chars_per_result: int = 25000,
) -> str:
    after = query.starts_after.isoformat() if query.starts_after else "any time"
    before = query.starts_before.isoformat() if query.starts_before else "any time"
    needles = _window_date_needles(query)
    lines = [
        f"Extract live events near {query.near or 'the queried area'}.",
        f"Time window (REQUIRED): start time must be >= {after} and < {before}.",
        f"Reject any event outside that window. Today is {datetime.now(timezone.utc).date().isoformat()}.",
        "Enumerate exhaustively every event that satisfies the rules.",
        "It is better to emit too many candidates than to miss any -- a",
        "downstream filter will trim. Do not cap or summarize.",
        "",
        "Search results:",
    ]
    for i, r in enumerate(results, 1):
        lines.append(f"[{i}] {r.title}")
        lines.append(f"    URL: {r.url}")
        body = (r.raw_content or r.content or "").strip()
        if body:
            body = body.replace("\r", " ")
            body = _truncate_with_window_bias(body, raw_chars_per_result, needles)
            for ln in body.split("\n"):
                if ln.strip():
                    lines.append(f"    {ln}")
        lines.append("")
    return "\n".join(lines)


def _fingerprint(title: str, starts_at: datetime, venue: str | None) -> str:
    norm = f"{title.strip().lower()}|{starts_at.isoformat()}|{(venue or '').strip().lower()}"
    return hashlib.sha1(norm.encode("utf-8")).hexdigest()[:16]


def _ensure_utc(dt: datetime) -> datetime:
    if dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def _in_bbox(lat: float, lng: float, bbox: tuple[float, float, float, float]) -> bool:
    s, w, n, e = bbox
    return s <= lat <= n and w <= lng <= e


def _in_window(
    starts_at: datetime,
    after: datetime | None,
    before: datetime | None,
) -> bool:
    if after is not None and starts_at < _ensure_utc(after):
        return False
    if before is not None and starts_at > _ensure_utc(before):
        return False
    return True


_WEEKDAY_NAMES: tuple[str, ...] = (
    "monday", "tuesday", "wednesday", "thursday",
    "friday", "saturday", "sunday",
)


def _stated_weekdays(item: "_LLMEvent") -> set[int]:
    """Whole-word weekday tokens ('Saturday', 'Sundays') mentioned in the
    title or description, as weekday indices (Mon=0..Sun=6).

    Avoids regex \\b because the project sticks to portable core regex
    elsewhere; a manual scan is fine here since the corpus is short.
    """
    text = f"{item.title or ''} {item.description or ''}".lower()
    found: set[int] = set()
    for i, name in enumerate(_WEEKDAY_NAMES):
        n = len(name)
        start = 0
        while True:
            idx = text.find(name, start)
            if idx < 0:
                break
            before = text[idx - 1] if idx > 0 else " "
            after_idx = idx + n
            after = text[after_idx] if after_idx < len(text) else " "
            if not before.isalpha():
                tail_ok = not after.isalpha() or (
                    after == "s"
                    and (after_idx + 1 >= len(text)
                         or not text[after_idx + 1].isalpha())
                )
                if tail_ok:
                    found.add(i)
            start = idx + 1
    return found


_WEEKLY_GATED_CATEGORIES: frozenset[EventCategory] = frozenset({
    EventCategory.farmers_market,
    EventCategory.community,
})


def _resolve_weekly_occurrence(
    item: "_LLMEvent",
    after: datetime | None,
    before: datetime | None,
) -> "_LLMEvent | None":
    """Enforce the prompt's "stated weekday must land in the window" rule
    for recurring weekly events. The LLM tends to violate it by stamping
    every weekly occurrence with the window-start date regardless of its
    actual day of week.

    If the item's category is one we gate (farmers markets and community
    meetups -- both dominated by weekly cadences) and the title or
    description names explicit weekdays, validate the assigned starts_at
    against that set. On mismatch, shift to the next stated-weekday
    occurrence inside [after, before); if no such occurrence exists,
    return None to signal a drop. Other categories pass through unchanged
    (they can opt in here later if mis-stamping shows up).
    """
    if item.category not in _WEEKLY_GATED_CATEGORIES:
        return item
    stated = _stated_weekdays(item)
    if not stated:
        return item
    current = _ensure_utc(item.starts_at)
    if current.weekday() in stated:
        return item
    if after is None or before is None:
        return None
    after_u = _ensure_utc(after)
    before_u = _ensure_utc(before)
    candidate = after_u.replace(
        hour=current.hour,
        minute=current.minute,
        second=0,
        microsecond=0,
    )
    while candidate < after_u:
        candidate += timedelta(days=1)
    while candidate < before_u:
        if candidate.weekday() in stated:
            return item.model_copy(update={"starts_at": candidate})
        candidate += timedelta(days=1)
    return None


def _extract_json_text(response: Any) -> str | None:
    for block in getattr(response, "content", []):
        text = getattr(block, "text", None)
        if text:
            return text
    return None


def _parse_llm_response(raw: str) -> "_LLMResponse | None":
    """Parse Claude's JSON; if the response was truncated mid-stream (e.g.
    max_tokens hit) salvage whatever complete event records we can."""
    try:
        return _LLMResponse.model_validate_json(raw)
    except Exception as e:
        logger.warning("LLM JSON parse failed (%s); attempting salvage", e)
    import json as _json
    import re as _re
    head = _re.search(r'"events"\s*:\s*\[', raw)
    if not head:
        return None
    pos = head.end()
    salvaged: list[dict[str, Any]] = []
    while pos < len(raw):
        # skip whitespace and commas
        while pos < len(raw) and raw[pos] in " \t\n\r,":
            pos += 1
        if pos >= len(raw) or raw[pos] != "{":
            break
        # find matching closing brace, respecting strings
        depth = 0
        in_str = False
        esc = False
        start = pos
        while pos < len(raw):
            c = raw[pos]
            if in_str:
                if esc:
                    esc = False
                elif c == "\\":
                    esc = True
                elif c == '"':
                    in_str = False
            else:
                if c == '"':
                    in_str = True
                elif c == "{":
                    depth += 1
                elif c == "}":
                    depth -= 1
                    if depth == 0:
                        pos += 1
                        break
            pos += 1
        else:
            break  # ran off end mid-object
        try:
            salvaged.append(_json.loads(raw[start:pos]))
        except Exception:
            break
    logger.warning("salvaged %d events from truncated response", len(salvaged))
    try:
        return _LLMResponse.model_validate({"events": salvaged})
    except Exception as e:
        logger.warning("salvage validation failed: %s", e)
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
        max_tokens: int = 16384,
        request_timeout_s: float = 180.0,
        search_provider: SearchProvider | None = None,
        geocoder: Geocoder | None = None,
        search_k: int = 15,
        fanout_per_bucket: int = 8,
        fanout_site_k: int = 4,
    ) -> None:
        self._client = client or anthropic.AsyncAnthropic(timeout=request_timeout_s)
        self._model = model
        self._max_tokens = max_tokens
        self._search: SearchProvider = search_provider or TavilySearchProvider()
        self._geocoder: Geocoder = geocoder or NominatimGeocoder()
        self._search_k = search_k
        self._fanout_per_bucket = fanout_per_bucket
        self._fanout_site_k = fanout_site_k

    async def _run_searches(
        self, query: EventQuery,
    ) -> list[tuple[str, list[SearchResult]]]:
        """Fan out to several Tavily searches and return labeled buckets.

        If the caller pinned `query.categories`, we honor that and do a
        single search (returned as one bucket). Otherwise we dispatch in
        parallel:
          - one query per `_FANOUT_BUCKETS` entry (category-shaped query)
          - one query per `_FANOUT_SITES` entry (generic query restricted
            to that platform's domain via Tavily `include_domains`)
        Each bucket preserves its own results. URLs are deduplicated
        across buckets on a first-come basis so the same page is never
        extracted twice.
        """
        if query.categories:
            q = _build_search_query(query)
            logger.info("tavily search: %r (k=%d)", q, self._search_k)
            results = await self._search.search(q, k=self._search_k)
            return [("pinned", results)]

        cat_queries: list[tuple[str, str, list[str] | None]] = [
            (
                f"cat:{'+'.join(c.value for c in cats)}",
                _build_search_query(query.model_copy(update={"categories": list(cats)})),
                None,
            )
            for cats in _FANOUT_BUCKETS
        ]
        site_queries: list[tuple[str, str, list[str] | None]] = [
            (
                f"site:{name}",
                _build_site_search_query(query, template),
                list(domains),
            )
            for name, domains, template in _FANOUT_SITES
        ]
        jobs = cat_queries + site_queries
        logger.info(
            "tavily fanout: %d category x k=%d, %d site x k=%d",
            len(cat_queries), self._fanout_per_bucket,
            len(site_queries), self._fanout_site_k,
        )
        for label, q, domains in jobs:
            logger.info("  - [%s] %r %s", label, q, domains or "")
        result_lists = await asyncio.gather(
            *(
                self._search.search(
                    q,
                    k=self._fanout_site_k if domains else self._fanout_per_bucket,
                    include_domains=domains,
                )
                for _, q, domains in jobs
            )
        )

        seen: set[str] = set()
        labeled: list[tuple[str, list[SearchResult]]] = []
        for (label, _, _), rs in zip(jobs, result_lists):
            bucket: list[SearchResult] = []
            for r in rs:
                if r.url in seen:
                    continue
                seen.add(r.url)
                bucket.append(r)
            labeled.append((label, bucket))
        per_bucket_counts = ",".join(
            f"{label}={len(rs)}->{len(bk)}"
            for (label, bk), rs in zip(labeled, result_lists)
        )
        logger.info(
            "tavily fanout: per-bucket raw->unique [%s] total_unique=%d",
            per_bucket_counts, sum(len(bk) for _, bk in labeled),
        )
        return labeled

    async def search(self, query: EventQuery) -> list[Event]:
        buckets = await self._run_searches(query)
        non_empty = [(label, rs) for label, rs in buckets if rs]
        if not non_empty:
            return []

        extracted_lists = await asyncio.gather(
            *(self._extract_one(query, label, rs) for label, rs in non_empty)
        )

        # Dedupe LLM items across buckets by content fingerprint so the
        # same event surfaced by overlapping searches doesn't double-geocode.
        seen_fp: set[str] = set()
        items: list[_LLMEvent] = []
        for sub in extracted_lists:
            for it in sub:
                fp = _fingerprint(it.title, _ensure_utc(it.starts_at), it.venue_name)
                if fp in seen_fp:
                    continue
                seen_fp.add(fp)
                items.append(it)

        events: list[Event] = []
        out_of_bbox = out_of_window = wrong_weekday = 0
        input_urls = {r.url for _, rs in non_empty for r in rs}
        touched_urls: set[str] = set()
        for item in items:
            touched_urls.add(item.url)
            resolved = _resolve_weekly_occurrence(
                item, query.starts_after, query.starts_before,
            )
            if resolved is None:
                wrong_weekday += 1
                logger.info(
                    "drop[weekday] %r starts=%s stated=%s",
                    item.title, _ensure_utc(item.starts_at).isoformat(),
                    sorted(_stated_weekdays(item)),
                )
                continue
            item = resolved
            ev = await self._promote(item, query.near)
            if ev is None:
                continue
            if not _in_bbox(ev.lat, ev.lng, query.bbox):
                out_of_bbox += 1
                logger.info(
                    "drop[bbox] %r @ %r (%.4f,%.4f) starts=%s",
                    ev.title, ev.venue_name, ev.lat, ev.lng,
                    ev.starts_at.isoformat(),
                )
                continue
            if not _in_window(ev.starts_at, query.starts_after, query.starts_before):
                out_of_window += 1
                logger.info(
                    "drop[window] %r starts=%s window=[%s, %s)",
                    ev.title, ev.starts_at.isoformat(),
                    query.starts_after.isoformat() if query.starts_after else "-",
                    query.starts_before.isoformat() if query.starts_before else "-",
                )
                continue
            events.append(ev)
        # Return the full in-window inventory; the EventService orchestrator
        # (and any CachedEventSource wrapping us) apply the caller's limit
        # after merging across sources. Capping here would poison the cache
        # with whatever limit the leader happened to request.
        same_host = 0
        for u in touched_urls:
            host = _host(u)
            if any(_host(iu) == host for iu in input_urls):
                same_host += 1
        logger.info(
            "url provenance: %d extractions cite an input URL, %d cite a per-event URL "
            "on an input host, %d cite a host not in input (%d unique input URLs)",
            len(touched_urls & input_urls),
            same_host - len(touched_urls & input_urls),
            len(touched_urls) - same_host,
            len(input_urls),
        )
        logger.info(
            "extracted=%d unique=%d kept=%d dropped(bbox=%d window=%d weekday=%d)",
            sum(len(s) for s in extracted_lists), len(items),
            len(events), out_of_bbox, out_of_window, wrong_weekday,
        )
        return events

    async def _extract_one(
        self, query: EventQuery, label: str, results: list[SearchResult],
    ) -> list[_LLMEvent]:
        """Run one LLM extraction call against a single fanout bucket."""
        try:
            response = await self._client.messages.create(
                model=self._model,
                max_tokens=self._max_tokens,
                system=_EXTRACTOR_SYSTEM_PROMPT,
                messages=[
                    {"role": "user",
                     "content": _build_extractor_prompt(query, results)}
                ],
                output_config={
                    "format": {
                        "type": "json_schema",
                        "schema": anthropic.transform_schema(_LLMResponse),
                    }
                },
            )
        except Exception as e:  # noqa: BLE001
            logger.warning("extract[%s] LLM call failed: %r", label, e)
            return []
        raw = _extract_json_text(response)
        if not raw:
            logger.info("extract[%s]: empty response", label)
            return []
        parsed = _parse_llm_response(raw)
        if parsed is None:
            logger.info("extract[%s]: unparseable response", label)
            return []
        logger.info("extract[%s]: %d events from %d results",
                    label, len(parsed.events), len(results))
        return list(parsed.events)

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
            category=item.category,
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
