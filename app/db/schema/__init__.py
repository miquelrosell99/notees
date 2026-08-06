"""Schema package for Notees database.

This package contains:
- constants: System constants, UUIDs, and helper functions
- sql: PostgreSQL DDL schema definition
- init: Database initialization and seeding functions

All public symbols are re-exported here for backward compatibility.

Note: "workspace" terminology has been replaced with "workspace" in v2.
Legacy aliases are provided for backward compatibility.
"""

from ...utils.datetime_utils import utc_now_iso
from .constants import (
    SCHEMA_VERSION,
    SYSTEM_CLASSES,
    SYSTEM_CLASS_UUIDS,
    SYSTEM_PROPERTY_UUIDS,
    generate_day_uuid,
    generate_month_uuid,
    generate_year_uuid,
    parse_date_uuid,
)
from .init import (
    create_workspace_for_user,
    get_or_create_user_workspace,
    init_database,
)
from .sql import SCHEMA_SQL

__all__ = [
    # Constants
    "SCHEMA_VERSION",
    "SYSTEM_CLASSES",
    "SYSTEM_CLASS_UUIDS",
    "SYSTEM_PROPERTY_UUIDS",
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
    "create_workspace_for_user",
    "get_or_create_user_workspace",
]
