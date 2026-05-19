"""One-off probe for Partiful: full locationInfo shape and explore-page slugs."""
import asyncio
import json
import re

import httpx


async def main() -> None:
    async with httpx.AsyncClient(
        timeout=20,
        follow_redirects=True,
        headers={"User-Agent": "Mozilla/5.0"},
    ) as c:
        r = await c.get("https://partiful.com/e/oECWQmG6nK2uHNZrmUTi")
        m = re.search(r'<script id="__NEXT_DATA__"[^>]*>(.*?)</script>', r.text, re.DOTALL)
        if not m:
            print("no __NEXT_DATA__")
            return
        data = json.loads(m.group(1))
        ev = data["props"]["pageProps"]["event"]
        print("=== locationInfo (full) ===")
        print(json.dumps(ev.get("locationInfo"), indent=2)[:1800])

        r2 = await c.get("https://partiful.com/explore/SF")
        print(f"\n=== explore/SF: status={r2.status_code} len={len(r2.text)} ===")
        slugs = sorted(set(re.findall(r"/e/([A-Za-z0-9]{15,30})", r2.text)))
        print(f"unique /e/ slugs: {len(slugs)}")
        print("first 5:", slugs[:5])
        mm = re.search(r'<script id="__NEXT_DATA__"[^>]*>(.*?)</script>', r2.text, re.DOTALL)
        if mm:
            d2 = json.loads(mm.group(1))
            pp = d2.get("props", {}).get("pageProps", {})
            print(f"explore pageProps keys: {list(pp.keys())[:25]}")
            feed = pp.get("feedItems") or []
            print(f"\n=== feedItems: {len(feed)} ===")
            for i, item in enumerate(feed[:3]):
                print(f"\n  --- feedItem[{i}] keys: {list(item.keys())} ---")
                ev = item.get("event")
                if ev:
                    print(f"  event keys ({len(ev)}): {sorted(ev.keys())[:30]}")
                    for k in ("title", "startDate", "endDate", "timezone", "locationInfo",
                             "isPublic", "status", "id", "image", "description"):
                        if k in ev:
                            s = json.dumps(ev[k], default=str)
                            print(f"    {k}: {s[:200]}")
            # sections might be themed buckets
            print(f"\n=== sections ===")
            seen_ids = {it.get("event", {}).get("id") for it in feed if it.get("event")}
            for s in pp.get("sections") or []:
                items = s.get("items") or []
                print(f"  section title={s.get('title')!r}  items={len(items)}")
                if items:
                    first = items[0]
                    print(f"    item keys: {list(first.keys())}")
                    ev = first.get("event") or {}
                    print(f"    event keys: {list(ev.keys())[:20]}")
                    new_ids = [it.get("event", {}).get("id") for it in items
                               if it.get("event", {}).get("id") not in seen_ids]
                    print(f"    new ids vs feedItems: {len(new_ids)}/{len(items)}")


if __name__ == "__main__":
    asyncio.run(main())
