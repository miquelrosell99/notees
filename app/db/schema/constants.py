"""Constants and helper functions for Notees database schema.

This module re-exports domain constants that are also needed during schema
initialization and migration, and keeps DB-specific constants (schema version,
default pages, system property definitions, default query AST) here.
"""

from __future__ import annotations

# Re-export pure domain constants so existing imports continue to work.
from app.domain.entities.constants import (
    DEFAULT_VIEW_CLASSES,
    SYSTEM_CLASS_ICONS,
    SYSTEM_CLASS_UUIDS,
    SYSTEM_CLASSES,
    SYSTEM_PAGE_UUIDS,
    SYSTEM_PROPERTY_UUIDS,
    TASK_ACTIVE_STATUSES,
    TASK_CLOSED_STATUSES,
    TASK_DEFAULT_STATUS,
    TASK_PRIORITY_OPTIONS,
    TASK_RECURRENCE_OPTIONS,
    TASK_STATUS_OPTIONS,
    generate_day_uuid,
    generate_month_uuid,
    generate_year_uuid,
    parse_date_uuid,
)

# Schema version for migrations
SCHEMA_VERSION = 6


# Default pages created on initialization
DEFAULT_PAGES = [
    "Inbox",
]


# System properties declared as DB records. The UUIDs reference the domain
# constants so the two layers stay in sync.
SYSTEM_PROPERTIES = [
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
]


# Default empty query AST (new format with scope and root_group)
DEFAULT_QUERY_AST = {
    "type": "query",
    "version": "1.0",
    "scope": {"type": "scope", "scope_type": "entire_workspace"},
    "root_group": {"type": "group", "logic": "AND", "children": []},
}


__all__ = [
    "DEFAULT_PAGES",
    "DEFAULT_QUERY_AST",
    "DEFAULT_VIEW_CLASSES",
    "SCHEMA_VERSION",
    "SYSTEM_CLASS_ICONS",
    "SYSTEM_CLASS_UUIDS",
    "SYSTEM_CLASSES",
    "SYSTEM_PAGE_UUIDS",
    "SYSTEM_PROPERTIES",
    "SYSTEM_PROPERTY_UUIDS",
    "TASK_ACTIVE_STATUSES",
    "TASK_CLOSED_STATUSES",
    "TASK_DEFAULT_STATUS",
    "TASK_PRIORITY_OPTIONS",
    "TASK_RECURRENCE_OPTIONS",
    "TASK_STATUS_OPTIONS",
    "generate_day_uuid",
    "generate_month_uuid",
    "generate_year_uuid",
    "parse_date_uuid",
]
