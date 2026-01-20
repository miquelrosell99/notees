"""Database operations for Notees with multi-database support.

This module provides:
- User-based database management (each user has their own databases)
- Multi-database management (create, switch, import, export)
- Unified Node operations with uuid, name, display_name
- Parent-based hierarchy for the structure
- Auto-export to Markdown on save
- Journal system with day/month/year tags

NOTE: This module now re-exports functions from submodules:
- db.nodes: Node CRUD operations
- db.queries: Search and query operations
- db.tasks: Task management
- db.export: Export operations
- db.graph: Graph operations
- db.sync: Sync operations
- db.database_mgmt: Database management
"""
import aiosqlite
import shutil
import json
import re
import uuid as uuid_module
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import List, Optional, Tuple, Dict, Any

from .models import ExportFormat
from .config import settings
from .logging_config import get_logger

# NOTE: Legacy imports have been removed.
# Node operations are now handled via app/domain/repositories and app/routers/nodes.py
# The functions below are stubs for backward compatibility during migration.

# Import from submodules that still exist
from .db.utils import get_user_setting, set_user_setting, generate_uuid, format_date_display

from .db.database_mgmt import (
    list_databases,
    create_database,
    delete_database,
    import_database,
    switch_database,
    export_database,
    rename_database,
)

from .db.export import (
    get_node_tree,
    export_nodes,
    auto_export_page_to_markdown,
    export_all_pages_to_markdown,
)

from .db.graph import (
    get_graph_data,
)

from .db.sync import (
    get_changes_since,
    apply_remote_changes,
    get_sync_status,
    set_last_sync_time,
)

# Re-export from db.connection - these are the canonical implementations
from .db.connection import (
    get_active_db_name,
    set_active_db,
    get_user_data_dir,
    get_databases_dir,
    get_db_path,
    get_db,
    init_db,
)


# Stub constants and functions for backward compatibility
TASK_STATES = ['todo', 'doing', 'done', 'cancelled']


async def create_node(*args, **kwargs):
    raise NotImplementedError("Use nodes router or repository instead")

async def get_node(*args, **kwargs):
    raise NotImplementedError("Use nodes router or repository instead")

async def get_node_by_uuid(*args, **kwargs):
    raise NotImplementedError("Use nodes router or repository instead")

async def get_node_by_name(*args, **kwargs):
    raise NotImplementedError("Use nodes router or repository instead")

async def get_daily_node(*args, **kwargs):
    raise NotImplementedError("Use nodes router or repository instead")

async def get_all_pages(*args, **kwargs):
    raise NotImplementedError("Use nodes router or repository instead")

async def get_root_pages(*args, **kwargs):
    raise NotImplementedError("Use nodes router or repository instead")

async def get_child_nodes(*args, **kwargs):
    raise NotImplementedError("Use nodes router or repository instead")

async def get_node_with_children(*args, **kwargs):
    raise NotImplementedError("Use nodes router or repository instead")

async def update_node(*args, **kwargs):
    raise NotImplementedError("Use nodes router or repository instead")

async def delete_node(*args, **kwargs):
    raise NotImplementedError("Use nodes router or repository instead")

async def move_node(*args, **kwargs):
    raise NotImplementedError("Use nodes router or repository instead")

async def ensure_year_page(*args, **kwargs):
    raise NotImplementedError("Use nodes router or repository instead")

async def ensure_month_page(*args, **kwargs):
    raise NotImplementedError("Use nodes router or repository instead")

async def create_or_get_daily_page(*args, **kwargs):
    raise NotImplementedError("Use nodes router or repository instead")

async def create_or_get_hierarchical_page(*args, **kwargs):
    raise NotImplementedError("Use nodes router or repository instead")

async def resolve_page_link(*args, **kwargs):
    raise NotImplementedError("Use nodes router or repository instead")

async def upsert_node(*args, **kwargs):
    raise NotImplementedError("Use nodes router or repository instead")

async def update_all_date_page_titles(*args, **kwargs):
    raise NotImplementedError("Use nodes router or repository instead")

async def ensure_inbox_page(*args, **kwargs):
    raise NotImplementedError("Use nodes router or repository instead")

async def search_nodes(*args, **kwargs):
    raise NotImplementedError("Use nodes router or repository instead")

async def get_backlinks(*args, **kwargs):
    raise NotImplementedError("Use nodes router or repository instead")

async def get_all_tags(*args, **kwargs):
    raise NotImplementedError("Use nodes router or repository instead")

async def get_nodes_by_tag(*args, **kwargs):
    raise NotImplementedError("Use nodes router or repository instead")

async def execute_query(*args, **kwargs):
    raise NotImplementedError("Use nodes router or repository instead")

async def get_tasks(*args, **kwargs):
    raise NotImplementedError("Use nodes router or repository instead")

async def update_task_state(*args, **kwargs):
    raise NotImplementedError("Use nodes router or repository instead")

async def get_templates(*args, **kwargs):
    raise NotImplementedError("Use nodes router or repository instead")

async def get_properties(*args, **kwargs):
    raise NotImplementedError("Use nodes router or repository instead")


# Helper to set date_format and update all date page titles
async def set_date_format_and_update_titles(user_id: str, new_date_format: str):
    await set_user_setting(user_id, "date_format", new_date_format)
    # update_all_date_page_titles is now a stub

logger = get_logger(__name__)

# Base data directory
DATA_DIR = settings.database_dir

# Cache for current user context (kept for backwards compatibility)
_current_user_id: Optional[str] = None
_current_db_name: Optional[str] = None


def set_current_user(user_id: str):
    """Set the current user context."""
    global _current_user_id
    _current_user_id = user_id


def get_current_user() -> Optional[str]:
    """Get the current user ID."""
    return _current_user_id


def get_export_dir(user_id: str, db_name: str) -> Path:
    """Get the export directory for a database."""
    from .db.connection import get_user_data_dir as _get_user_data_dir
    export_dir = _get_user_data_dir(user_id) / "export" / db_name
    export_dir.mkdir(parents=True, exist_ok=True)
    return export_dir


# ============ Utility Functions ============
# All other operations are imported from submodules above
