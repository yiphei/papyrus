"""Smoke-test the PartifulEventSource against a 7-day SF window."""
import asyncio
from datetime import datetime, timedelta, timezone

from papyrus.events.models import EventQuery
from papyrus.events.sources.partiful import PartifulEventSource


async def main() -> None:
    now = datetime.now(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)
    q = EventQuery(
        bbox=(37.70, -122.52, 37.83, -122.36),
        near="San Francisco",
        starts_after=now,
        starts_before=now + timedelta(days=7),
        limit=200,
    )
    src = PartifulEventSource()
    events = await src.search(q)
    print(f"\n=== {len(events)} events ===")
    for e in events[:25]:
        print(
            f"  {e.starts_at.isoformat()[:16]}  "
            f"{e.category.value:<10}  "
            f"{(e.title or '')[:48]:<48}  @{(e.venue_name or '-')[:30]:<30}  "
            f"({e.lat:.4f},{e.lng:.4f})"
        )


if __name__ == "__main__":
    asyncio.run(main())
