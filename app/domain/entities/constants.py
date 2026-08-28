"""Pure domain constants.

These constants are part of the domain model (system class UUIDs, system
property UUIDs, task statuses, view type names, date helpers). They live in the
domain layer so that domain services and repositories can depend on them
without importing DB-schema modules.
"""

from __future__ import annotations

from datetime import date
from typing import Any

# ---------------------------------------------------------------------------
# Date helpers
# ---------------------------------------------------------------------------


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


# ---------------------------------------------------------------------------
# System classes
# ---------------------------------------------------------------------------

SYSTEM_CLASSES = [
    "class",
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
    "cloze",
]

SYSTEM_CLASS_UUIDS = {
    "class": "00000000-0000-0000-0001-000000000001",
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
    "cloze": "00000000-0000-0000-0001-000000000022",
    "source": "00000000-0000-0000-0001-000000000023",
    "book": "00000000-0000-0000-0001-000000000024",
    "paper": "00000000-0000-0000-0001-000000000025",
    "article": "00000000-0000-0000-0001-000000000026",
    "thesis": "00000000-0000-0000-0001-000000000027",
    "document": "00000000-0000-0000-0001-000000000028",
    "agent": "00000000-0000-0000-0001-000000000029",
    "person": "00000000-0000-0000-0001-000000000030",
    "organization": "00000000-0000-0000-0001-000000000031",
    "collection": "00000000-0000-0000-0001-000000000032",
    "highlight": "00000000-0000-0000-0001-000000000033",
    "weblink": "00000000-0000-0000-0001-000000000034",
    "movie": "00000000-0000-0000-0001-000000000035",
}

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
    "cloze": "mdiEyeOff",
    "source": "mdiBookshelf",
    "book": "mdiBookOpenVariant",
    "paper": "mdiNewspaperVariantOutline",
    "article": "mdiNewspaper",
    "thesis": "mdiSchoolOutline",
    "document": "mdiFileOutline",
    "agent": "mdiAccountGroupOutline",
    "person": "mdiAccountOutline",
    "organization": "mdiDomain",
    "collection": "mdiFolderMultipleOutline",
    "highlight": "mdiFormatHighlight",
    "weblink": "mdiLinkVariant",
    "movie": "mdiMovieOpenOutline",
}


# ---------------------------------------------------------------------------
# System pages
# ---------------------------------------------------------------------------

SYSTEM_PAGE_UUIDS = {
    "scratchpad": "00000000-0000-0000-0002-000000000001",
    "inbox": "00000000-0000-0000-0002-000000000002",
}


# ---------------------------------------------------------------------------
# System properties
# ---------------------------------------------------------------------------

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
    # Source hierarchy & attachments
    "attachments": "00000000-0000-0000-0000-000000000011",
    "authors": "00000000-0000-0000-0000-000000000012",
    "isbn": "00000000-0000-0000-0000-000000000013",
    "doi": "00000000-0000-0000-0000-000000000014",
    "publication_date": "00000000-0000-0000-0000-000000000015",
    "publisher": "00000000-0000-0000-0000-000000000016",
    "role": "00000000-0000-0000-0000-000000000017",
    # "locator" (…0018) withdrawn — highlights carry position info as text; do not reuse
    "provenance": "00000000-0000-0000-0000-000000000019",
    "highlight_asset": "00000000-0000-0000-0000-000000000020",
    "given_name": "00000000-0000-0000-0000-000000000021",
    "family_name": "00000000-0000-0000-0000-000000000022",
    "citekey": "00000000-0000-0000-0000-000000000023",
    "url": "00000000-0000-0000-0000-000000000024",
}


# ---------------------------------------------------------------------------
# System class hierarchy & class-scoped property schemas
# ---------------------------------------------------------------------------

# Canonical extends edges between system classes, keyed by class name with
# parent class names as values. Mirrored in
# frontend/src/constants/systemProperties.ts and guarded by
# tests/core/test_system_uuid_parity.py.
SYSTEM_CLASS_EXTENDS = {
    "book": ["source"],
    "paper": ["source"],
    "article": ["source"],
    "thesis": ["source"],
    "document": ["source"],
    "movie": ["source"],
    "person": ["agent"],
    "organization": ["agent"],
}

# Class-scoped system property schemas, in canonical seed order. Keys are
# property names (also keys of SYSTEM_PROPERTY_UUIDS); ``bindTo`` names the
# system class the schema is bound to via a classPropertyEdge. Field names are
# camelCase so the mirrored frontend spec stays textually identical.
# Mirrored in frontend/src/constants/systemProperties.ts and guarded by
# tests/core/test_system_uuid_parity.py.
SYSTEM_PROPERTY_SCHEMA_SPECS: dict[str, dict[str, Any]] = {
    "attachments": {"type": "node", "multi": True, "classFilter": ["asset"], "bindTo": "source"},
    "authors": {"type": "node", "multi": True, "classFilter": ["agent"], "bindTo": "source"},
    "isbn": {"type": "text", "bindTo": "source"},
    "doi": {"type": "text", "bindTo": "source"},
    "publication_date": {"type": "date", "bindTo": "source"},
    "publisher": {"type": "text", "bindTo": "source"},
    "role": {
        "type": "selection",
        "options": [
            {"uuid": "00000000-0000-0000-0004-000000000001", "name": "representation", "sequence": 0},
            {"uuid": "00000000-0000-0000-0004-000000000002", "name": "cover", "sequence": 1},
            {"uuid": "00000000-0000-0000-0004-000000000003", "name": "supplement", "sequence": 2},
            {"uuid": "00000000-0000-0000-0004-000000000004", "name": "attachment", "sequence": 3},
            {"uuid": "00000000-0000-0000-0004-000000000005", "name": "generated", "sequence": 4},
            {"uuid": "00000000-0000-0000-0004-000000000006", "name": "thumbnail", "sequence": 5},
            {"uuid": "00000000-0000-0000-0004-000000000007", "name": "other", "sequence": 6},
        ],
        "bindTo": "asset",
    },
    "provenance": {"type": "text", "bindTo": "highlight"},
    "highlight_asset": {"type": "node", "classFilter": ["asset"], "bindTo": "highlight"},
    "given_name": {"type": "text", "bindTo": "person"},
    "family_name": {"type": "text", "bindTo": "person"},
    "citekey": {"type": "text", "defaultValue": "", "bindTo": "source"},
    "url": {"type": "url", "bindTo": "weblink"},
}


# Extra class-property bindings for base system properties whose schemas are
# created outside SYSTEM_PROPERTY_SCHEMA_SPECS (e.g. the global cover
# property): seeds/backfill emit only the classPropertyEdge, never the schema.
# ``sequence`` is the next free per-class slot (source's spec-bound schemas
# occupy 0-6). Mirrored in frontend/src/constants/systemProperties.ts and
# guarded by tests/core/test_system_uuid_parity.py.
SYSTEM_EXTRA_CLASS_BINDINGS: dict[str, dict[str, Any]] = {
    "cover": {"bindTo": "source", "sequence": 7},
}


# ---------------------------------------------------------------------------
# Task options
# ---------------------------------------------------------------------------

TASK_STATUS_OPTIONS = [
    {"name": "Backlog", "icon": "dots-circle"},
    {"name": "Pending", "icon": "circle-outline"},
    {"name": "Doing", "icon": '{"icon":"circle-slice-4","color":"var(--color-preset-yellow)"}'},
    {"name": "Reviewing", "icon": '{"icon":"help-circle-outline","color":"var(--color-preset-blue)"}'},
    {"name": "Done", "icon": '{"icon":"check-circle","color":"var(--color-preset-green)"}'},
    {"name": "Cancelled", "icon": '{"icon":"close-circle","color":"var(--color-preset-red)"}'},
]

TASK_CLOSED_STATUSES = {"Done", "Cancelled"}
TASK_DEFAULT_STATUS = "Pending"
TASK_ACTIVE_STATUSES = [
    opt["name"] for opt in TASK_STATUS_OPTIONS if opt["name"] not in TASK_CLOSED_STATUSES
]

TASK_PRIORITY_OPTIONS = [
    {"name": "Low", "icon": "chevron-down"},
    {"name": "Medium", "icon": "equal"},
    {"name": "High", "icon": "chevron-up"},
    {"name": "Urgent", "icon": "chevron-double-up"},
]

TASK_RECURRENCE_OPTIONS = [
    {"name": "Daily", "icon": "calendar-today"},
    {"name": "Every Weekday", "icon": "calendar-week"},
    {"name": "Weekly", "icon": "calendar-week"},
    {"name": "Biweekly", "icon": "calendar-multiselect"},
    {"name": "Monthly", "icon": "calendar-month"},
    {"name": "Yearly", "icon": "calendar-star"},
]


# ---------------------------------------------------------------------------
# View defaults
# ---------------------------------------------------------------------------

DEFAULT_VIEW_CLASSES = [
    "child_pages",
    "classed_nodes",
    "linked_references",
    "main_content",
]
