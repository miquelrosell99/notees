"""Date range normalization and validation utilities.

Date ranges are stored as JSON in property_value_scalar.value_text. This module
produces the canonical payload and the deterministic journal-page UUIDs needed
for inline links and QueryAST containment checks.
"""

from __future__ import annotations

import json
from datetime import date, datetime
from enum import StrEnum
from typing import Any

from app.domain.entities.constants import (
    generate_day_uuid,
    generate_month_uuid,
    generate_year_uuid,
    parse_date_uuid,
)


class DateRangeGranularity(StrEnum):
    """Granularity of a date range."""

    DAY = "day"
    MONTH = "month"
    YEAR = "year"


def _parse_iso_date(value: str | date | datetime) -> date:
    """Parse an ISO date string or date/datetime object into a date."""
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    if isinstance(value, str):
        value = value.strip()
        if not value:
            raise ValueError("Date value is empty")
        # Allow "YYYY-MM-DD" or datetime strings; take the date portion.
        if "T" in value:
            value = value.split("T")[0]
        return date.fromisoformat(value)
    raise ValueError(f"Invalid date value: {value!r}")


def _canonical_dates(start: date, end: date, granularity: DateRangeGranularity) -> tuple[date, date]:
    """Return canonical start/end dates for the requested granularity."""
    if granularity == DateRangeGranularity.DAY:
        return start, end

    if granularity == DateRangeGranularity.MONTH:
        start_canonical = date(start.year, start.month, 1)
        # Last day of end month: first day of next month minus one day.
        first_next = date(end.year + 1, 1, 1) if end.month == 12 else date(end.year, end.month + 1, 1)
        end_canonical = date.fromordinal(first_next.toordinal() - 1)
        return start_canonical, end_canonical

    # YEAR
    start_canonical = date(start.year, 1, 1)
    end_canonical = date(end.year, 12, 31)
    return start_canonical, end_canonical


def _uuid_for_date(d: date, granularity: DateRangeGranularity) -> str:
    """Generate the deterministic journal-page UUID for a date at a granularity."""
    if granularity == DateRangeGranularity.DAY:
        return generate_day_uuid(d)
    if granularity == DateRangeGranularity.MONTH:
        return generate_month_uuid(d.year, d.month)
    return generate_year_uuid(d.year)


def date_uuid_to_date(uuid: str) -> date:
    """Convert a deterministic journal-page UUID into its canonical date.

    Day UUIDs map to the exact day. Month and year UUIDs map to the first day
    of that month/year so they can be compared uniformly with date ranges.
    """
    info = parse_date_uuid(uuid)
    if info is None:
        raise ValueError(f"Not a date UUID: {uuid}")

    if info["type"] == "day":
        return date(info["year"], info["month"], info["day"])
    if info["type"] == "month":
        return date(info["year"], info["month"], 1)
    return date(info["year"], 1, 1)


def date_uuid_granularity(uuid: str) -> DateRangeGranularity:
    """Return the granularity of a date UUID."""
    info = parse_date_uuid(uuid)
    if info is None:
        raise ValueError(f"Not a date UUID: {uuid}")
    if info["type"] == "day":
        return DateRangeGranularity.DAY
    if info["type"] == "month":
        return DateRangeGranularity.MONTH
    return DateRangeGranularity.YEAR


def normalize_date_range(
    start: str | date | datetime,
    end: str | date | datetime,
    granularity: str,
) -> dict[str, Any]:
    """Normalize and validate a date range payload.

    Args:
        start: Start date (ISO string or date object).
        end: End date (ISO string or date object).
        granularity: "day", "month", or "year".

    Returns:
        Dict with canonical start/end ISO dates, granularity, and UUIDs.

    Raises:
        ValueError: If inputs are invalid or start > end.
    """
    try:
        g = DateRangeGranularity(granularity)
    except ValueError as exc:
        raise ValueError(f"Invalid granularity: {granularity!r}") from exc

    start_date = _parse_iso_date(start)
    end_date = _parse_iso_date(end)

    if start_date > end_date:
        raise ValueError("Start date must be before or equal to end date")

    start_canonical, end_canonical = _canonical_dates(start_date, end_date, g)

    return {
        "start": start_canonical.isoformat(),
        "end": end_canonical.isoformat(),
        "granularity": g.value,
        "start_uuid": _uuid_for_date(start_canonical, g),
        "end_uuid": _uuid_for_date(end_canonical, g),
    }


def normalize_date_range_value(value: Any) -> str:
    """Normalize a date range value and return its JSON string.

    Accepts:
      - A JSON string representing the payload.
      - A dict with start, end, granularity.

    Returns:
        Canonical JSON string for storage in property_value_scalar.value_text.
    """
    if isinstance(value, str):
        value = value.strip()
        if not value:
            raise ValueError("date_range value is empty")
        try:
            parsed = json.loads(value)
        except json.JSONDecodeError as exc:
            raise ValueError("date_range value is not valid JSON") from exc
        value = parsed

    if not isinstance(value, dict):
        raise ValueError("date_range value must be an object")

    start = value.get("start")
    end = value.get("end")
    granularity = value.get("granularity")
    if start is None or end is None or granularity is None:
        raise ValueError("date_range value must include start, end, and granularity")

    normalized = normalize_date_range(start, end, granularity)
    return json.dumps(normalized, separators=(",", ":"), sort_keys=True)
