"""Schema package for Notees database.

This package contains:
- constants: System constants, UUIDs, and helper functions
- sql: PostgreSQL DDL schema definition
- init: Database initialization and seeding functions

All public symbols are re-exported here for backward compatibility.

Note: "workspace" terminology has been replaced with "workspace" in v2.
Legacy aliases are provided for backward compatibility.
"""

from .constants import (
    DEFAULT_PAGES,
    SCHEMA_VERSION,
    SYSTEM_CLASS_ICONS,
    SYSTEM_CLASS_UUIDS,
    SYSTEM_CLASSES,
    SYSTEM_PROPERTIES,
    SYSTEM_PROPERTY_UUIDS,
    generate_day_uuid,
    generate_month_uuid,
    generate_year_uuid,
    parse_date_uuid,
    utc_now_iso,
)
from .init import (
    create_workspace_for_user,
    get_or_create_user_workspace,
    init_database,
    seed_workspace,
)
from .sql import SCHEMA_SQL

__all__ = [
    # Constants
    "SCHEMA_VERSION",
    "SYSTEM_CLASSES",
    "DEFAULT_PAGES",
    "SYSTEM_CLASS_UUIDS",
    "SYSTEM_CLASS_ICONS",
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
