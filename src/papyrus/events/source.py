"""EventSource protocol and the orchestrating EventService."""
from __future__ import annotations

import asyncio
import logging
from typing import ClassVar, Protocol, Sequence, runtime_checkable

from .models import BBox, Event, EventQuery, Region

logger = logging.getLogger(__name__)


@runtime_checkable
class EventSource(Protocol):
    """Contract every event source adapter implements.

    Adapters are free to be live API wrappers, cached snapshots, scrapers, or
    in-memory UGC stores. The orchestrator only sees `search`.
    """

    id: ClassVar[str]
    name: ClassVar[str]
    coverage: ClassVar[Region | None]  # None means global coverage

    async def search(self, query: EventQuery) -> list[Event]: ...


def coverage_intersects(coverage: Region | None, bbox: BBox) -> bool:
    if coverage is None:
        return True
    cs, cw, cn, ce = coverage.bbox
    qs, qw, qn, qe = bbox
    return not (cn < qs or cs > qn or ce < qw or cw > qe)


class EventService:
    """Fan out a query across registered sources, merge and dedup results."""

    def __init__(self, sources: Sequence[EventSource]) -> None:
        self._sources = list(sources)

    @property
    def sources(self) -> list[EventSource]:
        return list(self._sources)

    async def search(self, query: EventQuery) -> list[Event]:
        applicable = [
            s for s in self._sources if coverage_intersects(s.coverage, query.bbox)
        ]
        if not applicable:
            return []

        results = await asyncio.gather(
            *(s.search(query) for s in applicable),
            return_exceptions=True,
        )

        events: list[Event] = []
        seen: set[tuple[str, str]] = set()
        errors: list[tuple[str, BaseException]] = []
        for source, r in zip(applicable, results):
            if isinstance(r, BaseException):
                logger.exception("source %s failed", source.id, exc_info=r)
                errors.append((source.id, r))
                continue
            for ev in r:
                key = (ev.source_id, ev.source_event_id)
                if key in seen:
                    continue
                seen.add(key)
                events.append(ev)

        # If every applicable source failed, surface the first error so callers
        # see a real failure instead of an empty list.
        if errors and not events and len(errors) == len(applicable):
            source_id, exc = errors[0]
            raise RuntimeError(f"all sources failed; first error from {source_id}: {exc}") from exc

        events.sort(key=lambda e: e.starts_at)
        return events[: query.limit]
