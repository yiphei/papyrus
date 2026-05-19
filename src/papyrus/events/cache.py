"""TTL + single-flight cache wrapper for EventSources."""
from __future__ import annotations

import asyncio
import time
from collections import OrderedDict
from datetime import datetime
from typing import Hashable

from .models import Event, EventQuery
from .source import EventSource

CacheKey = tuple


def _round(x: float, step: float) -> float:
    return round(x / step) * step


def _bucket(dt: datetime | None, step_s: int) -> int | None:
    if dt is None:
        return None
    return int(dt.timestamp() // step_s)


def _query_key(q: EventQuery, bbox_step: float, time_step_s: int) -> CacheKey:
    s, w, n, e = q.bbox
    rb = (
        _round(s, bbox_step),
        _round(w, bbox_step),
        _round(n, bbox_step),
        _round(e, bbox_step),
    )
    cats = tuple(sorted(c.value for c in q.categories)) if q.categories else None
    # NOTE: q.limit deliberately excluded. The inner source returns its full
    # in-window inventory; the orchestrator applies the caller's limit after
    # merging. Including it here would fragment the cache so a 200-pin map
    # request and a 500-pin probe trigger separate upstream fetches.
    return (
        rb,
        q.near,
        _bucket(q.starts_after, time_step_s),
        _bucket(q.starts_before, time_step_s),
        cats,
        q.text,
    )


class TTLCache:
    """Async-safe TTL cache with LRU eviction."""

    def __init__(self, ttl_seconds: float, max_size: int = 256) -> None:
        self._ttl = ttl_seconds
        self._max = max_size
        self._data: OrderedDict[Hashable, tuple[float, list[Event]]] = OrderedDict()
        self._lock = asyncio.Lock()

    async def get(self, key: Hashable) -> list[Event] | None:
        async with self._lock:
            entry = self._data.get(key)
            if entry is None:
                return None
            expires, value = entry
            if expires < time.monotonic():
                self._data.pop(key, None)
                return None
            self._data.move_to_end(key)
            return value

    async def set(self, key: Hashable, value: list[Event]) -> None:
        async with self._lock:
            self._data[key] = (time.monotonic() + self._ttl, value)
            self._data.move_to_end(key)
            while len(self._data) > self._max:
                self._data.popitem(last=False)


class CachedEventSource:
    """Wraps another EventSource with a TTL cache and single-flight dedup.

    Identical concurrent queries share a single upstream call. Results are
    cached with the inner source's response for `ttl_seconds`. Cache keys
    bucket the bbox to `bbox_step` degrees and times to `time_step_s` seconds
    so small map pans/jitter hit the same cache entry.
    """

    def __init__(
        self,
        inner: EventSource,
        ttl_seconds: float = 900,
        max_size: int = 256,
        bbox_step: float = 0.01,
        time_step_s: int = 3600,
    ) -> None:
        self._inner = inner
        self._cache = TTLCache(ttl_seconds, max_size)
        self._bbox_step = bbox_step
        self._time_step_s = time_step_s
        self._inflight: dict[CacheKey, asyncio.Future[list[Event]]] = {}
        self._inflight_lock = asyncio.Lock()
        # mirror the inner source's identity so the orchestrator treats us as it
        self.id = inner.id
        self.name = inner.name
        self.coverage = inner.coverage

    async def search(self, query: EventQuery) -> list[Event]:
        key = _query_key(query, self._bbox_step, self._time_step_s)
        cached = await self._cache.get(key)
        if cached is not None:
            return cached

        leader = False
        async with self._inflight_lock:
            fut = self._inflight.get(key)
            if fut is None:
                fut = asyncio.get_running_loop().create_future()
                self._inflight[key] = fut
                leader = True

        if leader:
            asyncio.create_task(self._fetch_and_resolve(query, key, fut))
        return await fut

    async def _fetch_and_resolve(
        self,
        query: EventQuery,
        key: CacheKey,
        fut: asyncio.Future[list[Event]],
    ) -> None:
        try:
            result = await self._inner.search(query)
        except BaseException as exc:
            async with self._inflight_lock:
                self._inflight.pop(key, None)
            if not fut.done():
                fut.set_exception(exc)
            return
        await self._cache.set(key, result)
        async with self._inflight_lock:
            self._inflight.pop(key, None)
        if not fut.done():
            fut.set_result(result)
