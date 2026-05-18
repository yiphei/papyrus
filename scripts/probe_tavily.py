"""Tavily-only smoke test. No LLM, no geocoding.

Issues one search and prints the top results with timing.
"""
from __future__ import annotations

import asyncio
import time

from papyrus.search import TavilySearchProvider


async def main() -> None:
    provider = TavilySearchProvider()
    query = "live events in San Francisco this week"
    t0 = time.perf_counter()
    results = await provider.search(query, k=10)
    dt = time.perf_counter() - t0
    print(f"query={query!r}")
    print(f"results={len(results)} in {dt:.2f}s\n")
    for i, r in enumerate(results, 1):
        print(f"[{i}] {r.title}  (score={r.score})")
        print(f"    {r.url}")
        snippet = (r.content or "").strip().replace("\n", " ")
        if len(snippet) > 220:
            snippet = snippet[:220] + "…"
        print(f"    {snippet}\n")
    await provider.aclose()


if __name__ == "__main__":
    asyncio.run(main())
