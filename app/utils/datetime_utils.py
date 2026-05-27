"""Date/Time Utilities

Common date/time functions used throughout the application.
Consolidates duplicate utc_now() implementations from:
- app/routers/activity.py
- app/routers/sync.py
- app/domain/repositories/postgres_property.py
- app/domain/repositories/postgres_node.py
- app/domain/repositories/postgres_link.py
"""

from datetime import UTC, datetime


def utc_now() -> datetime:
    """Get current UTC datetime.

    Returns:
        Current datetime in UTC timezone
    """
    return datetime.now(UTC)


def utc_now_iso() -> str:
    """Get current UTC datetime as ISO 8601 string.

    Returns:
        Current datetime as ISO 8601 formatted string
    """
    return utc_now().isoformat()


def to_iso(dt: datetime | str | None) -> str:
    """Convert datetime to ISO 8601 string.

    Handles both datetime objects and strings (passthrough).

    Args:
        dt: datetime object, ISO string, or None

    Returns:
        ISO 8601 formatted string, or empty string if None
    """
    if dt is None:
        return ""
    if isinstance(dt, datetime):
        return dt.isoformat()
    return dt


def from_iso(iso_str: str | None) -> datetime | None:
    """Parse ISO 8601 string to datetime.

    Args:
        iso_str: ISO 8601 formatted string or None

    Returns:
        Parsed datetime or None
    """
    if not iso_str:
        return None
    return datetime.fromisoformat(iso_str.replace("Z", "+00:00"))


def normalize_timestamp(value: datetime | str | None) -> str:
    """Normalize timestamp to ISO string for entity conversion.

    Used in repository _row_to_* methods to handle both datetime
    and string representations from database.

    Args:
        value: datetime, ISO string, or None

    Returns:
        ISO 8601 string or empty string
    """
    if isinstance(value, datetime):
        return value.isoformat()
    return value or ""
