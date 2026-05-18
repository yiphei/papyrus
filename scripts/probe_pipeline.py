"""Direct probe of LLMEventSource with verbose logging.

Bypasses HTTP and cache so we can see Tavily query, extraction count, and
filter drops in real time.
"""
from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timedelta, timezone

from papyrus.events.models import EventQuery
from papyrus.events.sources.llm import LLMEventSource


async def main() -> None:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(name)s %(levelname)s %(message)s",
    )
    now = datetime.now(timezone.utc).replace(second=0, microsecond=0)
    query = EventQuery(
        bbox=(37.70, -122.52, 37.83, -122.36),
        near="San Francisco",
        starts_after=now,
        starts_before=now + timedelta(days=2),
        limit=15,
    )
    print(f"window: {query.starts_after.isoformat()}  →  {query.starts_before.isoformat()}")
    src = LLMEventSource()
    events = await src.search(query)
    print(f"\n=== final events: {len(events)} ===")
    for i, e in enumerate(events, 1):
        print(f"[{i}] {e.title}")
        print(f"    starts_at={e.starts_at.isoformat()}  category={e.category.value}")
        print(f"    venue={e.venue_name!r}  ({e.lat:.4f}, {e.lng:.4f})")
        print(f"    url={e.url}")


if __name__ == "__main__":
    asyncio.run(main())
