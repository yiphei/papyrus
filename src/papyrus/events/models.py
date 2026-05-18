"""Core data models for events."""
from __future__ import annotations

from datetime import datetime
from enum import Enum
from typing import Any
from uuid import UUID, uuid4

from pydantic import BaseModel, ConfigDict, Field

# (south, west, north, east) in WGS84 degrees
BBox = tuple[float, float, float, float]


class Region(BaseModel):
    bbox: BBox
    name: str | None = None


class EventCategory(str, Enum):
    concert = "concert"
    sports = "sports"
    theater = "theater"
    farmers_market = "farmers_market"
    festival = "festival"
    fair = "fair"
    exhibition = "exhibition"
    political = "political"
    community = "community"
    ugc = "ugc"
    other = "other"


class LocationPrecision(str, Enum):
    point = "point"
    venue = "venue"
    area = "area"
    region = "region"


class EventStatus(str, Enum):
    scheduled = "scheduled"
    cancelled = "cancelled"
    postponed = "postponed"


class Event(BaseModel):
    model_config = ConfigDict(extra="ignore")

    id: UUID = Field(default_factory=uuid4)
    source_id: str
    source_event_id: str
    title: str
    description: str | None = None
    category: EventCategory
    tags: list[str] = Field(default_factory=list)
    starts_at: datetime
    ends_at: datetime | None = None
    timezone: str | None = None
    recurrence_rule: str | None = None
    lat: float
    lng: float
    location_precision: LocationPrecision = LocationPrecision.point
    venue_name: str | None = None
    address: str | None = None
    url: str | None = None
    image_url: str | None = None
    price: str | None = None
    status: EventStatus = EventStatus.scheduled
    extra: dict[str, Any] = Field(default_factory=dict)


class EventQuery(BaseModel):
    bbox: BBox
    near: str | None = None
    starts_after: datetime | None = None
    starts_before: datetime | None = None
    categories: list[EventCategory] | None = None
    text: str | None = None
    limit: int = 200
