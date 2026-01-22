"""Database operations for Notees - PostgreSQL version.

This module provides minimal backward compatibility stubs.
All node operations are now handled via:
- app/domain/repositories (PostgreSQL implementations)
- app/routers/nodes.py (REST API endpoints)
- app/db/connection.py (connection pooling)
- app/db/schema.py (database schema)

NOTE: Most functions here are stubs that raise NotImplementedError.
Use the repository/router pattern instead.
"""
from pathlib import Path
from typing import Optional

from .config import settings
from .logging_config import get_logger

logger = get_logger(__name__)

# Base data directory for assets (file-based)
DATA_DIR = settings.database_dir

# Legacy task states constant (may still be referenced)
TASK_STATES = ['todo', 'doing', 'done', 'cancelled']


# ============== Stub Functions ==============
# These raise NotImplementedError to guide developers to the new pattern


async def create_node(*args, **kwargs):
    raise NotImplementedError("Use nodes router or PostgresNodeRepository instead")


async def get_node(*args, **kwargs):
    raise NotImplementedError("Use nodes router or PostgresNodeRepository instead")


async def get_node_by_uuid(*args, **kwargs):
    raise NotImplementedError("Use nodes router or PostgresNodeRepository instead")


async def get_node_by_name(*args, **kwargs):
    raise NotImplementedError("Use nodes router or PostgresNodeRepository instead")


async def get_daily_node(*args, **kwargs):
    raise NotImplementedError("Use nodes router or PostgresNodeRepository instead")


async def get_all_pages(*args, **kwargs):
    raise NotImplementedError("Use nodes router or PostgresNodeRepository instead")


async def get_root_pages(*args, **kwargs):
    raise NotImplementedError("Use nodes router or PostgresNodeRepository instead")


async def get_child_nodes(*args, **kwargs):
    raise NotImplementedError("Use nodes router or PostgresNodeRepository instead")


async def get_node_with_children(*args, **kwargs):
    raise NotImplementedError("Use nodes router or PostgresNodeRepository instead")


async def update_node(*args, **kwargs):
    raise NotImplementedError("Use nodes router or PostgresNodeRepository instead")


async def delete_node(*args, **kwargs):
    raise NotImplementedError("Use nodes router or PostgresNodeRepository instead")


async def move_node(*args, **kwargs):
    raise NotImplementedError("Use nodes router or PostgresNodeRepository instead")


async def ensure_year_page(*args, **kwargs):
    raise NotImplementedError("Use nodes router or PostgresNodeRepository instead")


async def ensure_month_page(*args, **kwargs):
    raise NotImplementedError("Use nodes router or PostgresNodeRepository instead")


async def create_or_get_daily_page(*args, **kwargs):
    raise NotImplementedError("Use nodes router or PostgresNodeRepository instead")


async def create_or_get_hierarchical_page(*args, **kwargs):
    raise NotImplementedError("Use nodes router or PostgresNodeRepository instead")


async def resolve_page_link(*args, **kwargs):
    raise NotImplementedError("Use nodes router or PostgresNodeRepository instead")


async def upsert_node(*args, **kwargs):
    raise NotImplementedError("Use nodes router or PostgresNodeRepository instead")


async def search_nodes(*args, **kwargs):
    raise NotImplementedError("Use nodes router or PostgresNodeRepository instead")


async def get_backlinks(*args, **kwargs):
    raise NotImplementedError("Use nodes router or PostgresNodeRepository instead")


async def get_all_tags(*args, **kwargs):
    raise NotImplementedError("Use nodes router or PostgresNodeRepository instead")


async def get_nodes_by_tag(*args, **kwargs):
    raise NotImplementedError("Use nodes router or PostgresNodeRepository instead")


async def execute_query(*args, **kwargs):
    raise NotImplementedError("Use nodes router or PostgresNodeRepository instead")


async def get_tasks(*args, **kwargs):
    raise NotImplementedError("Use nodes router or PostgresNodeRepository instead")


async def update_task_state(*args, **kwargs):
    raise NotImplementedError("Use nodes router or PostgresNodeRepository instead")


async def get_templates(*args, **kwargs):
    raise NotImplementedError("Use nodes router or PostgresNodeRepository instead")


async def get_properties(*args, **kwargs):
    raise NotImplementedError("Use properties router or PostgresPropertyRepository instead")


# ============== Legacy Context Management ==============
# Kept for backward compatibility but no longer used

_current_user_id: Optional[str] = None


def set_current_user(user_id: str):
    """Set the current user context (legacy - no longer used)."""
    global _current_user_id
    _current_user_id = user_id


def get_current_user() -> Optional[str]:
    """Get the current user ID (legacy - no longer used)."""
    return _current_user_id


# ============== Utility Functions ==============

def get_export_dir(user_id: str, db_name: str = "default") -> Path:
    """Get the export directory for a user.
    
    Note: In PostgreSQL version, consider using workspace-based paths instead.
    """
    from .db.connection import DATA_DIR
    export_dir = DATA_DIR / "users" / user_id / "export" / db_name
    export_dir.mkdir(parents=True, exist_ok=True)
    return export_dir

