"""Database operations package for Notees.

Provides PostgreSQL connection pooling and schema management.

Updated for workspace-based schema:
- workspace -> workspace terminology
- Added get_or_create_user_workspace (get_or_create_user_workspace is now an alias)
- Added get_workspace_assets_dir for workspace assets directory
"""

from app.utils.paths import (
    get_export_dir,
    get_workspace_assets_dir,
    get_workspace_dir,
)

from .connection import (
    DATA_DIR,
    close_pool,
    get_connection,
    get_data_dir,
    get_pool,
    get_pool_stats,
    get_transaction,
    get_workspace_uuid,
    init_pool,
)
from .schema import (
    SCHEMA_VERSION,
    SYSTEM_CLASSES,
    create_workspace_for_user,
    generate_day_uuid,
    generate_month_uuid,
    generate_year_uuid,
    get_or_create_user_workspace,
    init_database,
    parse_date_uuid,
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
    "get_data_dir",
    "DATA_DIR",
    # Schema - new workspace terminology
    "init_database",
    "create_workspace_for_user",
    "get_or_create_user_workspace",
    # Utilities
    "generate_day_uuid",
    "generate_month_uuid",
    "generate_year_uuid",
    "parse_date_uuid",
    "SYSTEM_CLASSES",
    "SCHEMA_VERSION",
]
