"""FastAPI surface for Papyrus.

Run with: uvicorn papyrus.api.main:app --reload
"""
from __future__ import annotations

import os
from datetime import datetime
from typing import Annotated

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware

from ..events import EventCategory, EventQuery, EventService
from ..events.cache import CachedEventSource
from ..events.sources.llm import LLMEventSource


def create_app(service: EventService) -> FastAPI:
    app = FastAPI(title="Papyrus", version="0.0.1")
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_methods=["GET"],
        allow_headers=["*"],
    )

    @app.get("/healthz")
    async def healthz() -> dict[str, str]:
        return {"status": "ok"}

    @app.get("/sources")
    async def sources() -> list[dict]:
        return [
            {
                "id": s.id,
                "name": s.name,
                "coverage": s.coverage.model_dump() if s.coverage else None,
            }
            for s in service.sources
        ]

    @app.get("/events")
    async def events(
        bbox: Annotated[str, Query(description="south,west,north,east")],
        near: Annotated[str | None, Query()] = None,
        starts_after: Annotated[datetime | None, Query()] = None,
        starts_before: Annotated[datetime | None, Query()] = None,
        categories: Annotated[list[EventCategory] | None, Query()] = None,
        text: Annotated[str | None, Query()] = None,
        limit: Annotated[int, Query(ge=1, le=500)] = 200,
    ) -> dict:
        bb = _parse_bbox(bbox)
        query = EventQuery(
            bbox=bb,
            near=near,
            starts_after=starts_after,
            starts_before=starts_before,
            categories=categories,
            text=text,
            limit=limit,
        )
        try:
            results = await service.search(query)
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(status_code=502, detail=f"upstream source failed: {exc}")
        return {"events": [e.model_dump(mode="json") for e in results]}

    return app


def _parse_bbox(raw: str) -> tuple[float, float, float, float]:
    try:
        parts = [float(x) for x in raw.split(",")]
    except ValueError:
        raise HTTPException(status_code=400, detail="bbox values must be numeric")
    if len(parts) != 4:
        raise HTTPException(
            status_code=400, detail="bbox must be 'south,west,north,east'"
        )
    s, w, n, e = parts
    if s >= n or w >= e:
        raise HTTPException(status_code=400, detail="bbox must satisfy south<north and west<east")
    return (s, w, n, e)


def _build_default_service() -> EventService:
    llm = LLMEventSource(
        model=os.environ.get("PAPYRUS_LLM_MODEL", "claude-sonnet-4-6"),
    )
    cache_ttl = float(os.environ.get("PAPYRUS_CACHE_TTL_S", "900"))
    cached = CachedEventSource(llm, ttl_seconds=cache_ttl)
    return EventService(sources=[cached])


app = create_app(_build_default_service())
