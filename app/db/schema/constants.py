"""Constants and helper functions for Notees database schema.

This module contains all system constants, UUIDs, and date-related
helper functions used throughout the application.
"""
from __future__ import annotations

from datetime import datetime, timezone, date
from typing import Optional

# Import from shared utility for consistency
from ...utils import utc_now_iso

# Schema version for migrations
SCHEMA_VERSION = 1


def generate_day_uuid(d: date) -> str:
    """Generate UUID for a day node.
    
    Format: 00000000-0000-0000-00DD-YYYYMMDD0000
    This creates a valid UUID with the date embedded in the last segment.
    """
    return f"00000000-0000-0000-00dd-{d.year:04d}{d.month:02d}{d.day:02d}0000"


def generate_month_uuid(year: int, month: int) -> str:
    """Generate UUID for a month node.
    
    Format: 00000000-0000-0000-00mm-YYYYMM000000
    """
    return f"00000000-0000-0000-00aa-{year:04d}{month:02d}000000"


def generate_year_uuid(year: int) -> str:
    """Generate UUID for a year node.
    
    Format: 00000000-0000-0000-00yy-YYYY00000000
    """
    return f"00000000-0000-0000-00bb-{year:04d}00000000"


def parse_date_uuid(uuid: str) -> Optional[dict]:
    """Parse a date UUID to extract year, month, day.
    
    Returns dict with 'type' ('year', 'month', 'day') and date components.
    Returns None if not a date UUID.
    """
    if not uuid or len(uuid) != 36:
        return None
    
    # Check for day UUID pattern: 00000000-0000-0000-00dd-YYYYMMDD0000
    if uuid.startswith("00000000-0000-0000-00dd-"):
        try:
            data = uuid[-12:]  # YYYYMMDD0000
            year = int(data[0:4])
            month = int(data[4:6])
            day = int(data[6:8])
            if 1900 <= year <= 2200 and 1 <= month <= 12 and 1 <= day <= 31:
                return {"type": "day", "year": year, "month": month, "day": day}
        except (ValueError, IndexError):
            pass
    
    # Check for month UUID pattern: 00000000-0000-0000-00aa-YYYYMM000000
    elif uuid.startswith("00000000-0000-0000-00aa-"):
        try:
            data = uuid[-12:]  # YYYYMM000000
            year = int(data[0:4])
            month = int(data[4:6])
            if 1900 <= year <= 2200 and 1 <= month <= 12:
                return {"type": "month", "year": year, "month": month}
        except (ValueError, IndexError):
            pass
    
    # Check for year UUID pattern: 00000000-0000-0000-00bb-YYYY00000000
    elif uuid.startswith("00000000-0000-0000-00bb-"):
        try:
            data = uuid[-12:]  # YYYY00000000
            year = int(data[0:4])
            if 1900 <= year <= 2200:
                return {"type": "year", "year": year}
        except (ValueError, IndexError):
            pass
    
    return None


# System class names - these are created on database initialization
SYSTEM_CLASSES = [
    "class",
    "page",
    "year",
    "month",
    "day",
    "quote",
    "query",
    "code",
    "asset",
    "whiteboard",
    "card",
    "task",
    "template",
    "comment",
]

# Default pages created on initialization
DEFAULT_PAGES = [
    "Inbox",
    "Quick Add",
]

# System classes with fixed UUIDs (never change these)
SYSTEM_CLASS_UUIDS = {
    "class": "00000000-0000-0000-0001-000000000001",
    "page": "00000000-0000-0000-0001-000000000002",
    "year": "00000000-0000-0000-0001-000000000003",
    "month": "00000000-0000-0000-0001-000000000004",
    "day": "00000000-0000-0000-0001-000000000005",
    "quote": "00000000-0000-0000-0001-000000000006",
    "query": "00000000-0000-0000-0001-000000000007",
    "code": "00000000-0000-0000-0001-000000000008",
    "asset": "00000000-0000-0000-0001-000000000009",
    "whiteboard": "00000000-0000-0000-0001-000000000010",
    "card": "00000000-0000-0000-0001-000000000011",
    "task": "00000000-0000-0000-0001-000000000012",
    "template": "00000000-0000-0000-0001-000000000013",
    "comment": "00000000-0000-0000-0001-000000000014",
}

# Default icons for system classes (MDI icon names)
SYSTEM_CLASS_ICONS = {
    "class": "shape",
    "day": "calendar-today",
    "month": "calendar-month",
    "year": "calendar-text",
    "quote": "format-quote-close",
    "query": "magnify",
    "asset": "paperclip",
    "whiteboard": "draw",
    "card": "card-outline",
    "template": "file-document-outline",
    "comment": "comment-outline",
}

# System properties with fixed UUIDs
SYSTEM_PROPERTY_UUIDS = {
    "tags": "00000000-0000-0000-0000-000000000001",
    # "classes" removed - now stored directly in node.class_ids column
    "show_hierarchy": "00000000-0000-0000-0000-000000000003",
    "used_in": "00000000-0000-0000-0000-000000000004",
    "cover": "00000000-0000-0000-0000-000000000005",
    "banner": "00000000-0000-0000-0000-000000000006",
    "_query_ast": "00000000-0000-0000-0000-000000000007",  # Hidden system property for query nodes
    "extends": "00000000-0000-0000-0000-000000000008",  # Class inheritance/extension
}

SYSTEM_PROPERTIES = [
    {"name": "tags", "type": "node", "multi": True, "is_system": True, "uuid": SYSTEM_PROPERTY_UUIDS["tags"]},
    # "classes" removed - now stored directly in node.class_ids column
    {"name": "show_hierarchy", "type": "boolean", "multi": False, "is_system": True, "uuid": SYSTEM_PROPERTY_UUIDS["show_hierarchy"]},
    {"name": "used_in", "type": "node", "multi": True, "is_system": True, "uuid": SYSTEM_PROPERTY_UUIDS["used_in"]},
    {"name": "cover", "type": "node", "multi": False, "is_system": True, "uuid": SYSTEM_PROPERTY_UUIDS["cover"]},
    {"name": "banner", "type": "node", "multi": False, "is_system": True, "uuid": SYSTEM_PROPERTY_UUIDS["banner"]},
    {"name": "_query_ast", "type": "text", "multi": False, "is_system": True, "uuid": SYSTEM_PROPERTY_UUIDS["_query_ast"]},
    {"name": "extends", "type": "node", "multi": True, "is_system": True, "uuid": SYSTEM_PROPERTY_UUIDS["extends"]},
]

# Default view classes for NodeViews
DEFAULT_VIEW_CLASSES = [
    "child_pages",
    "classed_nodes", 
    "linked_references",
    "main_content",
]

# Default empty query block tree (AND container with no blocks)
DEFAULT_QUERY_AST = {
    "type": "AND_CONTAINER",
    "blocks": []
}
