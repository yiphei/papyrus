"""Address geocoding.

A small `Geocoder` protocol plus a free Nominatim implementation. Used by
event sources that emit addresses but not coordinates (e.g. the LLM source).
Resolved coordinates are persisted to a SQLite file so subsequent runs (and
sibling sources sharing the same default path) bypass Nominatim's 1 req/sec
rate limit for previously-seen addresses.
"""
from __future__ import annotations

import asyncio
import logging
import os
import sqlite3
import time
from pathlib import Path
from typing import Protocol, runtime_checkable

import httpx

logger = logging.getLogger(__name__)


@runtime_checkable
class Geocoder(Protocol):
    async def geocode(self, query: str) -> tuple[float, float] | None: ...


def _resolve_cache_path(explicit: str | None) -> Path | None:
    """Where to persist geocode results.

    Precedence: explicit constructor arg > PAPYRUS_GEOCODE_CACHE_PATH env >
    default ~/.papyrus/geocode.sqlite. Either explicit="" or env="" disables
    persistence (returns None) for tests / ephemeral runs.
    """
    if explicit is not None:
        raw = explicit
    else:
        raw = os.environ.get("PAPYRUS_GEOCODE_CACHE_PATH")
        if raw is None:
            raw = str(Path.home() / ".papyrus" / "geocode.sqlite")
    raw = raw.strip()
    if not raw:
        return None
    return Path(raw).expanduser()


class _SqliteStore:
    """Thin synchronous SQLite wrapper for geocode results.

    The schema also records negative lookups (found=0) so we don't keep
    retrying Nominatim for addresses it can't resolve. Calls are synchronous
    because each lookup is a single indexed read on a local file (<1ms) and
    runs inside the geocoder's existing per-call critical section.
    """

    _SCHEMA = """
    CREATE TABLE IF NOT EXISTS geocode (
      query      TEXT PRIMARY KEY,
      lat        REAL,
      lng        REAL,
      found      INTEGER NOT NULL,
      fetched_at REAL NOT NULL
    )
    """

    def __init__(self, path: Path) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        self._path = path
        self._conn = sqlite3.connect(str(path), check_same_thread=False)
        self._conn.execute(self._SCHEMA)
        self._conn.commit()

    def get(self, key: str) -> tuple[float, float] | None | _Miss:
        row = self._conn.execute(
            "SELECT lat, lng, found FROM geocode WHERE query = ?", (key,)
        ).fetchone()
        if row is None:
            return _MISS
        lat, lng, found = row
        if not found or lat is None or lng is None:
            return None
        return (float(lat), float(lng))

    def put(self, key: str, value: tuple[float, float] | None) -> None:
        lat, lng = (value[0], value[1]) if value is not None else (None, None)
        found = 1 if value is not None else 0
        self._conn.execute(
            "INSERT OR REPLACE INTO geocode(query, lat, lng, found, fetched_at) "
            "VALUES(?, ?, ?, ?, ?)",
            (key, lat, lng, found, time.time()),
        )
        self._conn.commit()


class _Miss:
    """Sentinel distinguishing 'never queried' from 'queried, no result'."""


_MISS = _Miss()


class NominatimGeocoder:
    """OpenStreetMap Nominatim geocoder.

    Free, rate-limited to 1 req/sec per their usage policy. Layers an
    in-memory cache over a persistent SQLite store keyed by query string
    (addresses don't move). Negative results are cached too so hopeless
    queries don't burn rate-limit slots on every cold fetch.
    """

    _ENDPOINT = "https://nominatim.openstreetmap.org/search"

    def __init__(
        self,
        user_agent: str = "papyrus/0.0.1",
        min_interval_s: float = 1.0,
        timeout_s: float = 10.0,
        cache_path: str | None = None,
    ) -> None:
        self._user_agent = user_agent
        self._min_interval_s = min_interval_s
        self._timeout_s = timeout_s
        self._cache: dict[str, tuple[float, float] | None] = {}
        self._lock = asyncio.Lock()
        self._last_call: float = 0.0
        self._client: httpx.AsyncClient | None = None
        resolved = _resolve_cache_path(cache_path)
        self._store: _SqliteStore | None = None
        if resolved is not None:
            try:
                self._store = _SqliteStore(resolved)
                logger.info("geocode cache: persisting to %s", resolved)
            except sqlite3.Error as exc:
                logger.warning("geocode cache disabled (sqlite open failed): %s", exc)

    async def _get_client(self) -> httpx.AsyncClient:
        if self._client is None:
            self._client = httpx.AsyncClient(
                timeout=self._timeout_s,
                headers={"User-Agent": self._user_agent},
            )
        return self._client

    async def geocode(self, query: str) -> tuple[float, float] | None:
        key = query.strip().lower()
        if not key:
            return None
        if key in self._cache:
            return self._cache[key]
        if self._store is not None:
            stored = self._store.get(key)
            if not isinstance(stored, _Miss):
                self._cache[key] = stored
                return stored

        async with self._lock:
            # Another task may have populated the cache while we waited.
            if key in self._cache:
                return self._cache[key]
            now = asyncio.get_running_loop().time()
            wait = self._min_interval_s - (now - self._last_call)
            if wait > 0:
                await asyncio.sleep(wait)
            client = await self._get_client()
            transient_error = False
            try:
                resp = await client.get(
                    self._ENDPOINT,
                    params={"q": query, "format": "json", "limit": 1},
                )
                resp.raise_for_status()
                data = resp.json()
            except (httpx.HTTPError, ValueError) as exc:
                logger.warning("nominatim geocode failed for %r: %s", query, exc)
                data = None
                transient_error = True
            self._last_call = asyncio.get_running_loop().time()

        result: tuple[float, float] | None = None
        if data:
            try:
                lat = float(data[0]["lat"])
                lng = float(data[0]["lon"])
                result = (lat, lng)
            except (KeyError, ValueError, TypeError, IndexError):
                result = None
        self._cache[key] = result
        # Only persist authoritative outcomes: a real Nominatim response
        # (coord or empty array). Transient HTTP/network failures stay in
        # the per-process miss cache so the next cold run can retry them.
        if self._store is not None and not transient_error:
            try:
                self._store.put(key, result)
            except sqlite3.Error as exc:
                logger.warning("geocode cache write failed for %r: %s", key, exc)
        return result

    async def aclose(self) -> None:
        if self._client is not None:
            await self._client.aclose()
            self._client = None
