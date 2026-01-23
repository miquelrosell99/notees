"""Schema package for Notees database.

This package contains:
- constants: System constants, UUIDs, and helper functions
- sql: PostgreSQL DDL schema definition
- init: Database initialization and seeding functions

All public symbols are re-exported here for backward compatibility.
"""
from .constants import (
    SCHEMA_VERSION,
    utc_now_iso,
    generate_day_uuid,
    generate_month_uuid,
    generate_year_uuid,
    parse_date_uuid,
    SYSTEM_TYPES,
    DEFAULT_PAGES,
    SYSTEM_TYPE_UUIDS,
    SYSTEM_TYPE_ICONS,
    SYSTEM_PROPERTY_UUIDS,
    SYSTEM_PROPERTIES,
)

from .sql import SCHEMA_SQL

from .init import (
    init_database,
    seed_workspace,
    create_workspace_for_user,
    get_or_create_user_workspace,
)

__all__ = [
    # Constants
    "SCHEMA_VERSION",
    "SYSTEM_TYPES",
    "DEFAULT_PAGES",
    "SYSTEM_TYPE_UUIDS",
    "SYSTEM_TYPE_ICONS",
    "SYSTEM_PROPERTY_UUIDS",
    "SYSTEM_PROPERTIES",
    # Helper functions
    "utc_now_iso",
    "generate_day_uuid",
    "generate_month_uuid",
    "generate_year_uuid",
    "parse_date_uuid",
    # SQL
    "SCHEMA_SQL",
    # Init functions
    "init_database",
    "seed_workspace",
    "create_workspace_for_user",
    "get_or_create_user_workspace",
]
