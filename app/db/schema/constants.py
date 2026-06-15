"""Constants and helper functions for Notees database schema.

This module contains all system constants, UUIDs, and date-related
helper functions used throughout the application.
"""

from __future__ import annotations

from datetime import date

# Import from shared utility for consistency

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


def parse_date_uuid(uuid: str) -> dict | None:
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
    "table",
    "warning",
    "note",
    "tip",
    "info",
    "danger",
    "success",
]

# Default pages created on initialization
DEFAULT_PAGES = [
    "Inbox",
]

# System pages with fixed UUIDs (never change these)
SYSTEM_PAGE_UUIDS = {
    "scratchpad": "00000000-0000-0000-0002-000000000001",
    "inbox": "00000000-0000-0000-0002-000000000002",
}

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
    "table": "00000000-0000-0000-0001-000000000015",
    "warning": "00000000-0000-0000-0001-000000000016",
    "note": "00000000-0000-0000-0001-000000000017",
    "tip": "00000000-0000-0000-0001-000000000018",
    "info": "00000000-0000-0000-0001-000000000019",
    "danger": "00000000-0000-0000-0001-000000000020",
    "success": "00000000-0000-0000-0001-000000000021",
}

# Default icons for system classes (MDI camelCase keys as exported by @mdi/js)
SYSTEM_CLASS_ICONS = {
    "class": "mdiTagMultiple",
    "day": "mdiCalendarToday",
    "month": "mdiCalendarMonth",
    "year": "mdiCalendarText",
    "quote": "mdiFormatQuoteClose",
    "query": "mdiMagnify",
    "asset": "mdiPaperclip",
    "whiteboard": "mdiDraw",
    "card": "mdiCardOutline",
    "template": "mdiFileDocumentOutline",
    "task": "mdiCheckboxMarkedCircleOutline",
    "comment": "mdiCommentOutline",
    "table": "mdiTable",
    "warning": "mdiAlert",
    "note": "mdiNoteOutline",
    "tip": "mdiLightbulbOutline",
    "info": "mdiInformationOutline",
    "danger": "mdiAlertCircle",
    "success": "mdiCheckCircle",
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
    "_whiteboard_data": "00000000-0000-0000-0000-000000000010",  # Hidden system property for whiteboard layout
    "description": "00000000-0000-0000-0000-000000000009",  # text, multi
    # "extends" removed - now stored directly in class_extend table
    # Task class properties
    "task_status": "00000000-0000-0000-0003-000000000001",
    "task_deadline": "00000000-0000-0000-0003-000000000002",
    "task_scheduled": "00000000-0000-0000-0003-000000000003",
    "task_priority": "00000000-0000-0000-0003-000000000004",
    "task_closed_date": "00000000-0000-0000-0003-000000000005",
    "task_recurrence": "00000000-0000-0000-0003-000000000006",
}

# Task status options with their icons (icon field may be JSON with embedded color)
TASK_STATUS_OPTIONS = [
    {"name": "Backlog", "icon": "dots-circle"},
    {"name": "Pending", "icon": "circle-outline"},
    {"name": "Doing", "icon": '{"icon":"circle-slice-4","color":"var(--color-preset-yellow)"}'},
    {"name": "Reviewing", "icon": '{"icon":"help-circle-outline","color":"var(--color-preset-blue)"}'},
    {"name": "Done", "icon": '{"icon":"check-circle","color":"var(--color-preset-green)"}'},
    {"name": "Cancelled", "icon": '{"icon":"close-circle","color":"var(--color-preset-red)"}'},
]

# Centralized task status helpers derived from TASK_STATUS_OPTIONS.
# Import these instead of hardcoding status names throughout the codebase.
TASK_CLOSED_STATUSES = {"Done", "Cancelled"}
TASK_DEFAULT_STATUS = "Pending"
TASK_ACTIVE_STATUSES = [
    opt["name"] for opt in TASK_STATUS_OPTIONS if opt["name"] not in TASK_CLOSED_STATUSES
]

# Task priority options with their icons
TASK_PRIORITY_OPTIONS = [
    {"name": "Low", "icon": "chevron-down"},
    {"name": "Medium", "icon": "equal"},
    {"name": "High", "icon": "chevron-up"},
    {"name": "Urgent", "icon": "chevron-double-up"},
]

# Task recurrence options
TASK_RECURRENCE_OPTIONS = [
    {"name": "Daily", "icon": "calendar-today"},
    {"name": "Every Weekday", "icon": "calendar-week"},
    {"name": "Weekly", "icon": "calendar-week"},
    {"name": "Biweekly", "icon": "calendar-multiselect"},
    {"name": "Monthly", "icon": "calendar-month"},
    {"name": "Yearly", "icon": "calendar-star"},
]

SYSTEM_PROPERTIES = [
    # "tags" removed - now stored directly in node.tag_ids column
    # "classes" removed - now stored directly in node.class_ids column
    {
        "name": "Show hierarchy",
        "type": "boolean",
        "multi": False,
        "is_system": True,
        "uuid": SYSTEM_PROPERTY_UUIDS["show_hierarchy"],
    },
    {"name": "Used in", "type": "node", "multi": True, "is_system": True, "uuid": SYSTEM_PROPERTY_UUIDS["used_in"]},
    {"name": "Cover", "type": "node", "multi": False, "is_system": True, "uuid": SYSTEM_PROPERTY_UUIDS["cover"]},
    {"name": "Banner", "type": "node", "multi": False, "is_system": True, "uuid": SYSTEM_PROPERTY_UUIDS["banner"]},
    {
        "name": "_query_ast",
        "type": "text",
        "multi": False,
        "is_system": True,
        "uuid": SYSTEM_PROPERTY_UUIDS["_query_ast"],
    },
    {
        "name": "_whiteboard_data",
        "type": "text",
        "multi": False,
        "is_system": True,
        "uuid": SYSTEM_PROPERTY_UUIDS["_whiteboard_data"],
    },
    {
        "name": "Description",
        "type": "text",
        "multi": True,
        "is_system": True,
        "uuid": SYSTEM_PROPERTY_UUIDS["description"],
    },
    # "extends" removed - now stored directly in class_extend table
]

# Default view classes for NodeViews
DEFAULT_VIEW_CLASSES = [
    "child_pages",
    "classed_nodes",
    "linked_references",
    "main_content",
]

# Default empty query AST (new format with scope and root_group)
DEFAULT_QUERY_AST = {
    "type": "query",
    "version": "1.0",
    "scope": {"type": "scope", "scope_type": "entire_workspace"},
    "root_group": {"type": "group", "logic": "AND", "children": []},
}
