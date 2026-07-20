"""Migration: drop legacy node/property/asset tables.

The relay-based architecture stores all node, property, hierarchy, task, asset
and view state in per-workspace SQLite derived databases. The PostgreSQL tables
that previously held this data are no longer created on fresh installs and are
removed from existing databases by this migration.
"""

from __future__ import annotations

import asyncpg

# Tables that belong to the legacy PostgreSQL node/property/asset schema.
# Dropping is performed with IF EXISTS ... CASCADE so the migration is
# idempotent and safe to run on both fresh and already-clean databases.
LEGACY_TABLES = [
    "node_link",
    "node_property",
    "property_value_scalar",
    "property_value_relation",
    "property_value_selection",
    "property_selection_line",
    "property_class_filter",
    "class_property",
    "class_extend",
    "node_property",
    "property",
    "node_mention",
    "node_view",
    "node_activity",
    "node_version",
    "node_revision",
    "task_recurrence",
    "task_completion",
    "flashcard",
    "link_click",
    "undo_log",
    "asset",
    "asset_file",
    "node_path",
    "type_property",
    "type_extend",
    "type_inline",
    "class_inline",
    "node",
]

# Standalone functions and triggers that referenced the legacy node/link schema
# and are no longer recreated by SCHEMA_SQL.
LEGACY_FUNCTIONS = [
    "update_node_search_vector",
    "node_plain_text",
    "compute_node_search_text",
    "node_search_text_after_insert",
    "node_search_text_after_update",
    "node_link_search_text_change",
    "capture_node_version",
    "get_breadcrumbs",
    "update_workspace_write_date",
]


async def run(conn: asyncpg.Connection) -> None:
    """Drop legacy tables, functions and triggers if they still exist."""
    from app.logging_config import get_logger

    logger = get_logger(__name__)

    for table in LEGACY_TABLES:
        exists = await conn.fetchval(
            "SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = $1)",
            table,
        )
        if exists:
            await conn.execute(f'DROP TABLE IF EXISTS "{table}" CASCADE')
            logger.info(f"Dropped legacy table {table}")

    for function in LEGACY_FUNCTIONS:
        await conn.execute(f"DROP FUNCTION IF EXISTS {function}() CASCADE")

    # Legacy triggers that may have survived on other tables.
    for trigger, table in [
        ("node_write_date", "node"),
        ("property_write_date", "property"),
        ("node_update_workspace_write_date", "node"),
        ("node_search_update", "node"),
        ("node_search_text_insert_trigger", "node"),
        ("node_search_text_after_update_trigger", "node"),
        ("node_link_search_text_trigger", "node_link"),
        ("trg_node_version_capture", "node"),
    ]:
        await conn.execute(f"DROP TRIGGER IF EXISTS {trigger} ON {table}")
