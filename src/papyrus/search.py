"""Web search providers.

A small Protocol so event sources can be agnostic about which search backend
they use. One concrete impl below: Tavily, designed for LLM/RAG use cases.
"""
from __future__ import annotations

import os
from typing import Any, Protocol, runtime_checkable
from urllib.parse import urlparse

import httpx
from pydantic import BaseModel


class SearchResult(BaseModel):
    title: str
    url: str
    content: str  # short snippet (always present)
    raw_content: str | None = None  # full page text when requested
    score: float | None = None


@runtime_checkable
class SearchProvider(Protocol):
    async def search(
        self,
        query: str,
        k: int = 10,
        include_domains: list[str] | None = None,
    ) -> list[SearchResult]: ...


class TavilySearchProvider:
    """Tavily Search API. Free tier at https://tavily.com.

    Reads TAVILY_API_KEY from env if not supplied.
    """

    _ENDPOINT = "https://api.tavily.com/search"

    def __init__(
        self,
        api_key: str | None = None,
        timeout_s: float = 45.0,
        search_depth: str = "advanced",
        include_raw_content: bool = True,
    ) -> None:
        key = api_key or os.environ.get("TAVILY_API_KEY")
        if not key:
            raise ValueError("TAVILY_API_KEY is not set")
        self._api_key = key
        self._timeout_s = timeout_s
        self._search_depth = search_depth
        self._include_raw_content = include_raw_content
        self._client: httpx.AsyncClient | None = None

    async def _get_client(self) -> httpx.AsyncClient:
        if self._client is None:
            self._client = httpx.AsyncClient(timeout=self._timeout_s)
        return self._client

    async def search(
        self,
        query: str,
        k: int = 10,
        include_domains: list[str] | None = None,
    ) -> list[SearchResult]:
        client = await self._get_client()
        payload: dict[str, Any] = {
            "api_key": self._api_key,
            "query": query,
            "max_results": k,
            "search_depth": self._search_depth,
            "include_raw_content": self._include_raw_content,
        }
        if include_domains:
            payload["include_domains"] = include_domains
        resp = await client.post(self._ENDPOINT, json=payload)
        resp.raise_for_status()
        data = resp.json()
        out: list[SearchResult] = []
        for r in data.get("results", []):
            url = r.get("url") or ""
            title = r.get("title") or ""
            if not url or not title:
                continue
            out.append(
                SearchResult(
                    title=title,
                    url=url,
                    content=r.get("content") or "",
                    raw_content=r.get("raw_content"),
                    score=r.get("score"),
                )
            )
        return out

    async def aclose(self) -> None:
        if self._client is not None:
            await self._client.aclose()
            self._client = None
