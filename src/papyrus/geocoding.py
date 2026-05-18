"""Address geocoding.

A small `Geocoder` protocol plus a free Nominatim implementation. Used by
event sources that emit addresses but not coordinates (e.g. the LLM source).
"""
from __future__ import annotations

import asyncio
import logging
from typing import Protocol, runtime_checkable

import httpx

logger = logging.getLogger(__name__)


@runtime_checkable
class Geocoder(Protocol):
    async def geocode(self, query: str) -> tuple[float, float] | None: ...


class NominatimGeocoder:
    """OpenStreetMap Nominatim geocoder.

    Free, rate-limited to 1 req/sec per their usage policy. Caches results
    in-memory by query string forever (addresses don't move).
    """

    _ENDPOINT = "https://nominatim.openstreetmap.org/search"

    def __init__(
        self,
        user_agent: str = "papyrus/0.0.1",
        min_interval_s: float = 1.0,
        timeout_s: float = 10.0,
    ) -> None:
        self._user_agent = user_agent
        self._min_interval_s = min_interval_s
        self._timeout_s = timeout_s
        self._cache: dict[str, tuple[float, float] | None] = {}
        self._lock = asyncio.Lock()
        self._last_call: float = 0.0
        self._client: httpx.AsyncClient | None = None

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

        async with self._lock:
            now = asyncio.get_running_loop().time()
            wait = self._min_interval_s - (now - self._last_call)
            if wait > 0:
                await asyncio.sleep(wait)
            client = await self._get_client()
            try:
                resp = await client.get(
                    self._ENDPOINT,
                    params={"q": query, "format": "json", "limit": 1},
                )
                resp.raise_for_status()
                data = resp.json()
            except (httpx.HTTPError, ValueError) as exc:
                logger.warning("nominatim geocode failed for %r: %s", query, exc)
                self._cache[key] = None
                self._last_call = asyncio.get_running_loop().time()
                return None
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
        return result

    async def aclose(self) -> None:
        if self._client is not None:
            await self._client.aclose()
            self._client = None
