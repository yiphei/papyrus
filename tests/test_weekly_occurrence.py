"""Regression tests for the weekday-enforcement post-filter that catches
mis-stamped weekly events emitted by the LLM (farmers markets, community
meetups). Mirrors the inline harness that originally validated the fix."""
from __future__ import annotations

import unittest
from datetime import datetime, timezone

from papyrus.events.models import EventCategory
from papyrus.events.sources.llm import (
    _LLMEvent,
    _resolve_weekly_occurrence,
    _stated_weekdays,
)


def _event(
    *,
    title: str = "Test Event",
    description: str | None = None,
    category: EventCategory = EventCategory.farmers_market,
    starts_at: datetime,
) -> _LLMEvent:
    return _LLMEvent(
        title=title,
        description=description,
        category=category,
        starts_at=starts_at,
        url="https://example.com/e",
    )


# Tue 2026-05-19 through Thu 2026-05-21 (exclusive end), the same shape
# of window the production fetch uses.
WINDOW_AFTER = datetime(2026, 5, 19, 12, 0, tzinfo=timezone.utc)
WINDOW_BEFORE = datetime(2026, 5, 21, 23, 0, tzinfo=timezone.utc)


class StatedWeekdaysTests(unittest.TestCase):
    def test_single_weekday(self):
        item = _event(
            title="Saturday Farmers Market",
            starts_at=WINDOW_AFTER,
        )
        self.assertEqual(_stated_weekdays(item), {5})

    def test_plural_form(self):
        item = _event(title="Open Sundays 9am-2pm", starts_at=WINDOW_AFTER)
        self.assertEqual(_stated_weekdays(item), {6})

    def test_description_scanned(self):
        item = _event(
            title="Heart of the City",
            description="Held every Wednesday and Sunday rain or shine.",
            starts_at=WINDOW_AFTER,
        )
        self.assertEqual(_stated_weekdays(item), {2, 6})

    def test_substring_not_matched(self):
        item = _event(
            title="Sundaes & Brunch",  # contains 'sunda' but not 'sunday'
            starts_at=WINDOW_AFTER,
        )
        self.assertEqual(_stated_weekdays(item), set())

    def test_no_weekday(self):
        item = _event(title="Pop-Up Market", starts_at=WINDOW_AFTER)
        self.assertEqual(_stated_weekdays(item), set())


class ResolveWeeklyOccurrenceTests(unittest.TestCase):
    def test_farmers_market_correct_day_passes(self):
        # Wed 2026-05-20 falls on weekday index 2.
        starts = datetime(2026, 5, 20, 16, 0, tzinfo=timezone.utc)
        item = _event(
            title="Heart of the City - Wednesday",
            starts_at=starts,
        )
        out = _resolve_weekly_occurrence(item, WINDOW_AFTER, WINDOW_BEFORE)
        self.assertIs(out, item)

    def test_saturday_market_in_tue_thu_window_is_dropped(self):
        # The bug: LLM stamps a Saturday market with the window start (Tue).
        starts = datetime(2026, 5, 19, 14, 0, tzinfo=timezone.utc)
        item = _event(
            title="Saturday Farmers Market at the Plaza",
            starts_at=starts,
        )
        out = _resolve_weekly_occurrence(item, WINDOW_AFTER, WINDOW_BEFORE)
        self.assertIsNone(out)

    def test_wrong_day_but_stated_day_in_window_is_shifted(self):
        # Stated Thursday, but stamped Tuesday inside a Tue-Thu window:
        # shift forward to Thursday 2026-05-21 keeping the hour.
        starts = datetime(2026, 5, 19, 17, 30, tzinfo=timezone.utc)
        item = _event(
            title="Thursday Evening Farmers Market",
            starts_at=starts,
        )
        out = _resolve_weekly_occurrence(item, WINDOW_AFTER, WINDOW_BEFORE)
        self.assertIsNotNone(out)
        self.assertEqual(out.starts_at.weekday(), 3)
        self.assertEqual(
            out.starts_at,
            datetime(2026, 5, 21, 17, 30, tzinfo=timezone.utc),
        )

    def test_no_stated_weekday_passes_through(self):
        starts = datetime(2026, 5, 19, 14, 0, tzinfo=timezone.utc)
        item = _event(title="Pop-Up Market", starts_at=starts)
        out = _resolve_weekly_occurrence(item, WINDOW_AFTER, WINDOW_BEFORE)
        self.assertIs(out, item)

    def test_non_gated_category_passes_through(self):
        # Concerts are not weekly-gated; a "Saturday" in the title must
        # not cause a drop or shift.
        starts = datetime(2026, 5, 19, 3, 0, tzinfo=timezone.utc)
        item = _event(
            title="Saturday Night Live tribute show",
            category=EventCategory.concert,
            starts_at=starts,
        )
        out = _resolve_weekly_occurrence(item, WINDOW_AFTER, WINDOW_BEFORE)
        self.assertIs(out, item)

    def test_community_weekly_meetup_wrong_day_dropped(self):
        # Community is now gated alongside farmers_market; a "Sunday
        # volunteer day" stamped on a Tuesday must be dropped.
        starts = datetime(2026, 5, 19, 17, 0, tzinfo=timezone.utc)
        item = _event(
            title="Sunday Volunteer Day at the Shelter",
            category=EventCategory.community,
            starts_at=starts,
        )
        out = _resolve_weekly_occurrence(item, WINDOW_AFTER, WINDOW_BEFORE)
        self.assertIsNone(out)

    def test_community_correct_day_passes(self):
        starts = datetime(2026, 5, 20, 18, 0, tzinfo=timezone.utc)
        item = _event(
            title="Wednesday Run Club",
            category=EventCategory.community,
            starts_at=starts,
        )
        out = _resolve_weekly_occurrence(item, WINDOW_AFTER, WINDOW_BEFORE)
        self.assertIs(out, item)


if __name__ == "__main__":
    unittest.main()
