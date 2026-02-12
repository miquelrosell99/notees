"""Database operations package for Notees.

Provides PostgreSQL connection pooling and schema management.

Updated for workspace-based schema:
- workspace -> workspace terminology
- Added get_or_create_user_workspace (get_or_create_user_workspace is now an alias)
- Added get_workspace_assets_dir for workspace assets directory
"""

from .connection import (
    init_pool,
    close_pool,
    get_pool,
    get_connection,
    get_transaction,
    get_pool_stats,
    get_workspace_assets_dir,
    get_workspace_uuid,
    get_workspace_dir,
    get_export_dir,
    DATA_DIR,
)

from .schema import (
    init_database,
    seed_workspace,
    create_workspace_for_user,
    get_or_create_user_workspace,
    generate_day_uuid,
    generate_month_uuid,
    generate_year_uuid,
    parse_date_uuid,
    SYSTEM_CLASSES,
    SYSTEM_CLASS_UUIDS,
    SYSTEM_PROPERTY_UUIDS,
    SCHEMA_VERSION,
)

__all__ = [
    # Connection
    "init_pool",
    "close_pool",
    "get_pool",
    "get_connection",
    "get_transaction",
    "get_pool_stats",
    "get_workspace_assets_dir",
    "get_workspace_uuid",
    "get_workspace_dir",
    "get_export_dir",
    "DATA_DIR",
    # Schema - new workspace terminology
    "init_database",
    "seed_workspace",
    "create_workspace_for_user",
    "get_or_create_user_workspace",
    # Utilities
    "generate_day_uuid",
    "generate_month_uuid",
    "generate_year_uuid",
    "parse_date_uuid",
    "SYSTEM_CLASSES",
    "SYSTEM_CLASS_UUIDS",
    "SYSTEM_PROPERTY_UUIDS",
    "SCHEMA_VERSION",
]
