"""Database initialization and seeding functions for Notees.

This module contains functions for initializing the database schema
and seeding workspaces with system data.

SCHEMA VERSION: 2 - Workspace-based architecture.
"""
from __future__ import annotations

import asyncpg
from datetime import datetime, timezone

from ...domain.entities import generate_uuid
from ...domain.stringify_ast import parse_ast, serialize_ast, ParseMode
from .constants import (
    SCHEMA_VERSION,
    SYSTEM_CLASSES,
    SYSTEM_CLASS_UUIDS,
    SYSTEM_CLASS_ICONS,
    SYSTEM_PROPERTY_UUIDS,
    SYSTEM_PAGE_UUIDS,
    DEFAULT_PAGES,
    TASK_STATUS_OPTIONS,
    TASK_PRIORITY_OPTIONS,
    TASK_RECURRENCE_OPTIONS,
)
from .sql import SCHEMA_SQL


async def init_database(conn: asyncpg.Connection) -> None:
    """Initialize the database with schema.
    
    This creates all tables, indexes, and triggers.
    Call this during application startup.
    """
    # Execute schema (creates tables if they don't exist)
    await conn.execute(SCHEMA_SQL)
    
    # Rebuild the node_path closure table only if it is empty.
    # Triggers keep it up-to-date during normal operation, so a full rebuild on
    # every startup is unnecessary and extremely slow on large datasets.
    node_path_count = await conn.fetchval("SELECT COUNT(*) FROM node_path")
    if node_path_count == 0:
        await conn.execute("SELECT rebuild_node_path()")
    
    # Repair any blocks with missing page_id using the closure table
    await _repair_page_ids(conn)
    
    # Store schema version
    await conn.execute("""
        INSERT INTO schema_meta (key, value, updated_at) 
        VALUES ('version', $1, NOW())
        ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()
    """, str(SCHEMA_VERSION))
    
    # Repair node_view JSON columns that were stored as strings instead of proper JSON
    await _repair_node_view_json_columns(conn)
    
    # Ensure task_recurrence property exists in all workspaces (migration for existing DBs)
    await _ensure_task_recurrence_property(conn)


async def _repair_node_view_json_columns(conn: asyncpg.Connection) -> None:
    """Fix node_view columns that were accidentally stored as JSON strings.
    
    Some imports or older code paths stored shown_properties or query_json
    as JSON strings (e.g. '"[]"') instead of proper JSON values (e.g. []).
    This uses PostgreSQL's jsonb_typeof to identify and repair them.
    """
    from ...logging_config import get_logger
    logger = get_logger(__name__)
    
    # Fix shown_properties that are JSON strings instead of arrays
    result = await conn.execute("""
        UPDATE node_view
        SET shown_properties = '[]'::jsonb
        WHERE jsonb_typeof(shown_properties) = 'string'
    """)
    sp_count = int(result.split()[-1]) if result else 0
    if sp_count > 0:
        logger.info(f"Repaired shown_properties for {sp_count} node_view rows")
    
    # Fix query_json that are JSON strings instead of objects
    result = await conn.execute("""
        UPDATE node_view
        SET query_json = '{"type": "AND_CONTAINER", "blocks": []}'::jsonb
        WHERE jsonb_typeof(query_json) = 'string'
    """)
    qj_count = int(result.split()[-1]) if result else 0
    if qj_count > 0:
        logger.info(f"Repaired query_json for {qj_count} node_view rows")


async def _repair_page_ids(conn: asyncpg.Connection) -> None:
    """Fix blocks that have NULL page_id but have a page ancestor.
    
    Uses the closure table (node_path) to find the nearest page ancestor
    for each block and sets page_id accordingly. Only updates rows that
    actually need fixing, so this is fast when the data is already correct.
    
    Also clears page_id on pages that should never have it set.
    """
    # Clear page_id on pages - pages should never have page_id
    clear_result = await conn.execute("""
        UPDATE node
        SET page_id = NULL
        WHERE is_page = TRUE AND page_id IS NOT NULL AND active = TRUE
    """)
    clear_count = int(clear_result.split()[-1]) if clear_result else 0
    if clear_count > 0:
        from ...logging_config import get_logger
        logger = get_logger(__name__)
        logger.info(f"Cleared erroneous page_id from {clear_count} pages")

    result = await conn.execute("""
        UPDATE node n
        SET page_id = nearest_page.id
        FROM (
            SELECT DISTINCT ON (np.descendant_id)
                np.descendant_id,
                ancestor.id
            FROM node_path np
            JOIN node ancestor ON ancestor.id = np.ancestor_id
            WHERE ancestor.is_page = TRUE
              AND ancestor.active = TRUE
              AND np.depth > 0
            ORDER BY np.descendant_id, np.depth ASC
        ) nearest_page
        WHERE n.id = nearest_page.descendant_id
          AND n.is_page = FALSE
          AND n.active = TRUE
          AND n.page_id IS NULL
    """)
    # asyncpg returns "UPDATE N" where N is the count
    count = int(result.split()[-1]) if result else 0
    if count > 0:
        from ...logging_config import get_logger
        logger = get_logger(__name__)
        logger.info(f"Repaired page_id for {count} blocks")


async def _ensure_task_recurrence_property(conn: asyncpg.Connection) -> None:
    """Ensure the task_recurrence property exists in all workspaces.
    
    Idempotent migration for existing databases that don't have
    the recurrence property yet.
    """
    from ...logging_config import get_logger
    logger = get_logger(__name__)
    
    recurrence_uuid = SYSTEM_PROPERTY_UUIDS["task_recurrence"]
    task_uuid = SYSTEM_CLASS_UUIDS["task"]
    
    # Get all workspaces that have the task class but not the recurrence property
    workspaces = await conn.fetch("""
        SELECT DISTINCT w.workspace_id, w.task_node_id
        FROM (
            SELECT n.workspace_id, n.id AS task_node_id
            FROM node n
            WHERE n.uuid = $1 AND n.active = TRUE
        ) w
        WHERE NOT EXISTS (
            SELECT 1 FROM property p
            WHERE p.workspace_id = w.workspace_id AND p.uuid = $2
        )
    """, task_uuid, recurrence_uuid)
    
    if not workspaces:
        return
    
    from datetime import datetime, timezone
    now = datetime.now(timezone.utc)
    
    for ws in workspaces:
        workspace_id = ws['workspace_id']
        task_class_id = ws['task_node_id']
        
        # Get a user_id from the workspace
        user_row = await conn.fetchrow("""
            SELECT create_uid FROM node WHERE workspace_id = $1 AND create_uid IS NOT NULL LIMIT 1
        """, workspace_id)
        user_id = user_row['create_uid'] if user_row else 1
        
        recurrence_row = await conn.fetchrow("""
            INSERT INTO property (uuid, workspace_id, name, icon, type, is_multi, is_system, create_date, write_date, create_uid, write_uid)
            VALUES ($1, $2, 'Recurrence', 'mdi:repeat', 'selection', FALSE, FALSE, $3, $3, $4, $4)
            ON CONFLICT (workspace_id, uuid) DO UPDATE SET uuid = EXCLUDED.uuid
            RETURNING id
        """, recurrence_uuid, workspace_id, now, user_id)
        
        if recurrence_row:
            recurrence_property_id = recurrence_row['id']
            for opt in TASK_RECURRENCE_OPTIONS:
                await conn.execute("""
                    INSERT INTO property_selection_line (property_id, name, icon)
                    VALUES ($1, $2, $3)
                """, recurrence_property_id, opt["name"], opt["icon"])
            
            await conn.execute("""
                INSERT INTO class_property (class_node_id, property_id, sequence)
                VALUES ($1, $2, 5)
                ON CONFLICT (class_node_id, property_id) DO NOTHING
            """, task_class_id, recurrence_property_id)
            
            logger.info(f"Created task_recurrence property for workspace {workspace_id}")


async def seed_workspace(conn: asyncpg.Connection, workspace_id: int, user_id: int) -> None:
    """Seed a workspace with system types, properties, and default pages.
    
    This should be called when creating a new workspace.
    
    Args:
        conn: Database connection
        workspace_id: The ID of the workspace to seed
        user_id: The user ID for create_uid/write_uid fields
    """
    now = datetime.now(timezone.utc)
    
    # Helper to get or create node_property assignment
    async def get_or_create_node_property(node_id: int, property_id: int) -> int:
        """Get or create a node_property assignment."""
        row = await conn.fetchrow(
            "SELECT id FROM node_property WHERE node_id = $1 AND property_id = $2",
            node_id, property_id
        )
        if row:
            return row['id']
        row = await conn.fetchrow("""
            INSERT INTO node_property (uuid, node_id, property_id, create_date, write_date, create_uid, write_uid)
            VALUES ($1, $2, $3, $4, $4, $5, $5)
            RETURNING id
        """, generate_uuid(), node_id, property_id, now, user_id)
        if not row:
            raise RuntimeError(f"Failed to create node_property for node {node_id}")
        return row['id']
    
    # Create 'class' node (renamed from 'type')
    class_uuid = SYSTEM_CLASS_UUIDS["class"]
    class_icon = SYSTEM_CLASS_ICONS.get("class")
    class_row = await conn.fetchrow("""
        INSERT INTO node (uuid, workspace_id, name, icon, is_class, is_page, create_date, write_date, create_uid, write_uid)
        VALUES ($1, $2, $3, $4, TRUE, TRUE, $5, $5, $6, $6)
        RETURNING id
    """, class_uuid, workspace_id, serialize_ast(parse_ast('class', ParseMode.PLAIN)), class_icon, now, user_id)
    if class_row is None:
        raise RuntimeError("Failed to create 'class' node")
    class_node_id = class_row['id']
    
    # Create 'page' class node
    page_uuid = SYSTEM_CLASS_UUIDS["page"]
    page_row = await conn.fetchrow("""
        INSERT INTO node (uuid, workspace_id, name, is_class, is_page, create_date, write_date, create_uid, write_uid)
        VALUES ($1, $2, $3, TRUE, TRUE, $4, $4, $5, $5)
        RETURNING id
    """, page_uuid, workspace_id, serialize_ast(parse_ast('page', ParseMode.PLAIN)), now, user_id)
    if page_row is None:
        raise RuntimeError("Failed to create 'page' node")
    page_class_id = page_row['id']
    
    
    # Classes are now stored in node.class_ids column (no longer a property)
    # Assign classes to 'class' node using direct UPDATE
    await conn.execute("""
        UPDATE node SET class_ids = $1 WHERE id = $2
    """, [class_node_id, page_class_id], class_node_id)
    
    # Assign classes to 'page' node using direct UPDATE
    await conn.execute("""
        UPDATE node SET class_ids = $1 WHERE id = $2
    """, [class_node_id, page_class_id], page_class_id)
    
    # Create other system properties
    show_hier_uuid = SYSTEM_PROPERTY_UUIDS["show_hierarchy"]
    await conn.execute("""
        INSERT INTO property (uuid, workspace_id, name, type, is_multi, is_system, create_date, write_date, create_uid, write_uid)
        VALUES ($1, $2, 'Show hierarchy', 'boolean', FALSE, TRUE, $3, $3, $4, $4)
        ON CONFLICT (workspace_id, uuid) DO NOTHING
    """, show_hier_uuid, workspace_id, now, user_id)
    
    # Create 'Cover' property
    cover_uuid = SYSTEM_PROPERTY_UUIDS["cover"]
    cover_row = await conn.fetchrow("""
        INSERT INTO property (uuid, workspace_id, name, type, is_multi, is_system, create_date, write_date, create_uid, write_uid)
        VALUES ($1, $2, 'Cover', 'image', FALSE, TRUE, $3, $3, $4, $4)
        ON CONFLICT (workspace_id, uuid) DO UPDATE SET uuid = EXCLUDED.uuid
        RETURNING id
    """, cover_uuid, workspace_id, now, user_id)
    if cover_row is None:
        raise RuntimeError("Failed to create 'Cover' property")
    cover_property_id = cover_row['id']
    
    # Create 'Banner' property
    banner_uuid = SYSTEM_PROPERTY_UUIDS["banner"]
    banner_row = await conn.fetchrow("""
        INSERT INTO property (uuid, workspace_id, name, type, is_multi, is_system, create_date, write_date, create_uid, write_uid)
        VALUES ($1, $2, 'Banner', 'image', FALSE, TRUE, $3, $3, $4, $4)
        ON CONFLICT (workspace_id, uuid) DO UPDATE SET uuid = EXCLUDED.uuid
        RETURNING id
    """, banner_uuid, workspace_id, now, user_id)
    if banner_row is None:
        raise RuntimeError("Failed to create 'Banner' property")
    banner_property_id = banner_row['id']
    
    # Create 'Description' property (multi text)
    description_uuid = SYSTEM_PROPERTY_UUIDS["description"]
    await conn.execute("""
        INSERT INTO property (uuid, workspace_id, name, type, is_multi, is_system, create_date, write_date, create_uid, write_uid)
        VALUES ($1, $2, 'Description', 'text', TRUE, TRUE, $3, $3, $4, $4)
        ON CONFLICT (workspace_id, uuid) DO NOTHING
    """, description_uuid, workspace_id, now, user_id)
    
    # Note: 'extends' property removed - class inheritance now uses class_extend table directly
    
    # Create remaining system classes
    asset_type_id = None
    task_class_id = None
    
    for class_name in SYSTEM_CLASSES:
        if class_name in ("class", "page"):
            continue
        
        class_uuid = SYSTEM_CLASS_UUIDS.get(class_name, generate_uuid())
        class_icon = SYSTEM_CLASS_ICONS.get(class_name)
        
        row = await conn.fetchrow("""
            INSERT INTO node (uuid, workspace_id, name, icon, is_class, is_page, create_date, write_date, create_uid, write_uid)
            VALUES ($1, $2, $3, $4, TRUE, TRUE, $5, $5, $6, $6)
            RETURNING id
        """, class_uuid, workspace_id, serialize_ast(parse_ast(class_name, ParseMode.PLAIN)), class_icon, now, user_id)
        if row is None:
            raise RuntimeError(f"Failed to create '{class_name}' class node")
        new_class_id = row['id']
        
        if class_name == "asset":
            asset_type_id = new_class_id
        if class_name == "task":
            task_class_id = new_class_id
        
        # Assign 'class' and 'page' classes using direct UPDATE to class_ids column
        await conn.execute("""
            UPDATE node SET class_ids = $1 WHERE id = $2
        """, [class_node_id, page_class_id], new_class_id)
    
    # Set class filter for 'Cover' and 'Banner' properties
    if asset_type_id:
        await conn.execute("""
            INSERT INTO property_class_filter (property_id, class_node_id)
            VALUES ($1, $2)
            ON CONFLICT DO NOTHING
        """, cover_property_id, asset_type_id)
        await conn.execute("""
            INSERT INTO property_class_filter (property_id, class_node_id)
            VALUES ($1, $2)
            ON CONFLICT DO NOTHING
        """, banner_property_id, asset_type_id)
    
    # Create task class properties (Status, Deadline, Scheduled, Priority)
    if task_class_id:
        # 1. Create 'Status' selection property
        status_row = await conn.fetchrow("""
            INSERT INTO property (uuid, workspace_id, name, icon, type, is_multi, is_system, icon_visibility, create_date, write_date, create_uid, write_uid)
            VALUES ($1, $2, 'Status', 'mdi:list-status', 'selection', FALSE, FALSE, 'after_bullet', $3, $3, $4, $4)
            ON CONFLICT (workspace_id, uuid) DO UPDATE SET uuid = EXCLUDED.uuid
            RETURNING id
        """, SYSTEM_PROPERTY_UUIDS["task_status"], workspace_id, now, user_id)
        if status_row:
            status_property_id = status_row['id']
            # Create status options
            pending_option_id = None
            for i, opt in enumerate(TASK_STATUS_OPTIONS):
                opt_row = await conn.fetchrow("""
                    INSERT INTO property_selection_line (property_id, name, icon)
                    VALUES ($1, $2, $3)
                    RETURNING id
                """, status_property_id, opt["name"], opt["icon"])
                if opt_row and opt["name"] == "Pending":
                    pending_option_id = opt_row['id']
            
            # Link status property to task class with "Pending" as default
            await conn.execute("""
                INSERT INTO class_property (class_node_id, property_id, sequence, default_selection_id)
                VALUES ($1, $2, 0, $3)
                ON CONFLICT (class_node_id, property_id) DO NOTHING
            """, task_class_id, status_property_id, pending_option_id)
        
        # 2. Create 'Deadline' date property
        deadline_row = await conn.fetchrow("""
            INSERT INTO property (uuid, workspace_id, name, icon, type, is_multi, is_system, create_date, write_date, create_uid, write_uid)
            VALUES ($1, $2, 'Deadline', 'mdi:calendar-clock', 'date', FALSE, FALSE, $3, $3, $4, $4)
            ON CONFLICT (workspace_id, uuid) DO UPDATE SET uuid = EXCLUDED.uuid
            RETURNING id
        """, SYSTEM_PROPERTY_UUIDS["task_deadline"], workspace_id, now, user_id)
        if deadline_row:
            await conn.execute("""
                INSERT INTO class_property (class_node_id, property_id, sequence)
                VALUES ($1, $2, 1)
                ON CONFLICT (class_node_id, property_id) DO NOTHING
            """, task_class_id, deadline_row['id'])
        
        # 3. Create 'Scheduled' date property
        scheduled_row = await conn.fetchrow("""
            INSERT INTO property (uuid, workspace_id, name, icon, type, is_multi, is_system, create_date, write_date, create_uid, write_uid)
            VALUES ($1, $2, 'Scheduled Date', 'mdi:calendar-check', 'date', FALSE, FALSE, $3, $3, $4, $4)
            ON CONFLICT (workspace_id, uuid) DO UPDATE SET uuid = EXCLUDED.uuid
            RETURNING id
        """, SYSTEM_PROPERTY_UUIDS["task_scheduled"], workspace_id, now, user_id)
        if scheduled_row:
            await conn.execute("""
                INSERT INTO class_property (class_node_id, property_id, sequence)
                VALUES ($1, $2, 2)
                ON CONFLICT (class_node_id, property_id) DO NOTHING
            """, task_class_id, scheduled_row['id'])
        
        # 4. Create 'Priority' selection property
        priority_row = await conn.fetchrow("""
            INSERT INTO property (uuid, workspace_id, name, icon, type, is_multi, is_system, create_date, write_date, create_uid, write_uid)
            VALUES ($1, $2, 'Priority', 'mdi:flag', 'selection', FALSE, FALSE, $3, $3, $4, $4)
            ON CONFLICT (workspace_id, uuid) DO UPDATE SET uuid = EXCLUDED.uuid
            RETURNING id
        """, SYSTEM_PROPERTY_UUIDS["task_priority"], workspace_id, now, user_id)
        if priority_row:
            priority_property_id = priority_row['id']
            for i, opt in enumerate(TASK_PRIORITY_OPTIONS):
                await conn.execute("""
                    INSERT INTO property_selection_line (property_id, name, icon)
                    VALUES ($1, $2, $3)
                """, priority_property_id, opt["name"], opt["icon"])
            
            # Link priority property to task class (no default)
            await conn.execute("""
                INSERT INTO class_property (class_node_id, property_id, sequence)
                VALUES ($1, $2, 3)
                ON CONFLICT (class_node_id, property_id) DO NOTHING
            """, task_class_id, priority_property_id)
        
        # 5. Create 'Closed Date' date property
        closed_date_row = await conn.fetchrow("""
            INSERT INTO property (uuid, workspace_id, name, icon, type, is_multi, is_system, create_date, write_date, create_uid, write_uid)
            VALUES ($1, $2, 'Closed Date', 'mdi:calendar-remove', 'date', FALSE, FALSE, $3, $3, $4, $4)
            ON CONFLICT (workspace_id, uuid) DO UPDATE SET uuid = EXCLUDED.uuid
            RETURNING id
        """, SYSTEM_PROPERTY_UUIDS["task_closed_date"], workspace_id, now, user_id)
        if closed_date_row:
            await conn.execute("""
                INSERT INTO class_property (class_node_id, property_id, sequence)
                VALUES ($1, $2, 4)
                ON CONFLICT (class_node_id, property_id) DO NOTHING
            """, task_class_id, closed_date_row['id'])
        
        # 6. Create 'Recurrence' selection property
        recurrence_row = await conn.fetchrow("""
            INSERT INTO property (uuid, workspace_id, name, icon, type, is_multi, is_system, create_date, write_date, create_uid, write_uid)
            VALUES ($1, $2, 'Recurrence', 'mdi:repeat', 'selection', FALSE, FALSE, $3, $3, $4, $4)
            ON CONFLICT (workspace_id, uuid) DO UPDATE SET uuid = EXCLUDED.uuid
            RETURNING id
        """, SYSTEM_PROPERTY_UUIDS["task_recurrence"], workspace_id, now, user_id)
        if recurrence_row:
            recurrence_property_id = recurrence_row['id']
            for i, opt in enumerate(TASK_RECURRENCE_OPTIONS):
                await conn.execute("""
                    INSERT INTO property_selection_line (property_id, name, icon)
                    VALUES ($1, $2, $3)
                """, recurrence_property_id, opt["name"], opt["icon"])
            
            # Link recurrence property to task class (no default)
            await conn.execute("""
                INSERT INTO class_property (class_node_id, property_id, sequence)
                VALUES ($1, $2, 5)
                ON CONFLICT (class_node_id, property_id) DO NOTHING
            """, task_class_id, recurrence_property_id)
    
    # Create default pages
    for page_name in DEFAULT_PAGES:
        row = await conn.fetchrow("""
            INSERT INTO node (uuid, workspace_id, name, is_page, create_date, write_date, create_uid, write_uid)
            VALUES ($1, $2, $3, TRUE, $4, $4, $5, $5)
            RETURNING id
        """, generate_uuid(), workspace_id, serialize_ast(parse_ast(page_name, ParseMode.PLAIN)), now, user_id)
        if row is None:
            raise RuntimeError(f"Failed to create '{page_name}' page")
        new_page_id = row['id']
        
        # Assign 'page' class using direct UPDATE to class_ids column
        await conn.execute("""
            UPDATE node SET class_ids = $1 WHERE id = $2
        """, [page_class_id], new_page_id)
    
    # Create Scratchpad system page with fixed UUID
    scratchpad_uuid = SYSTEM_PAGE_UUIDS["scratchpad"]
    scratchpad_row = await conn.fetchrow("""
        INSERT INTO node (uuid, workspace_id, name, is_page, create_date, write_date, create_uid, write_uid)
        VALUES ($1, $2, $3, TRUE, $4, $4, $5, $5)
        ON CONFLICT (workspace_id, uuid) DO NOTHING
        RETURNING id
    """, scratchpad_uuid, workspace_id, serialize_ast(parse_ast('Scratchpad', ParseMode.PLAIN)), now, user_id)
    if scratchpad_row:
        await conn.execute("""
            UPDATE node SET class_ids = $1 WHERE id = $2
        """, [page_class_id], scratchpad_row['id'])


async def create_workspace_for_user(
    conn: asyncpg.Connection,
    user_id: int,
    name: str = "Default"
) -> int:
    """Create a new workspace for a user and seed it with system data.
    
    Args:
        conn: Database connection
        user_id: The user ID (owner of the workspace)
        name: Name for the new workspace (defaults to "Default")
        
    Returns:
        The workspace ID
    """
    now = datetime.now(timezone.utc)
    
    # Create workspace
    row = await conn.fetchrow("""
        INSERT INTO workspace (name, create_uid, write_uid, create_date, write_date)
        VALUES ($1, $2, $2, $3, $3)
        RETURNING id
    """, name, user_id, now)
    if row is None:
        raise RuntimeError("Failed to create workspace")
    workspace_id = row['id']
    
    # Seed workspace with system data
    await seed_workspace(conn, workspace_id, user_id)
    
    return workspace_id


async def get_or_create_user_workspace(
    conn: asyncpg.Connection,
    user_id: int,
    workspace_uuid: str | None = None,
) -> int:
    """Resolve the user's workspace.
    
    If workspace_uuid is provided, resolves that specific workspace.
    Otherwise falls back to the user's first owned/shared workspace.
    
    Checks for:
    1. Specific workspace by UUID (if provided)
    2. Workspaces owned by the user (create_uid)
    3. Workspaces shared with the user (workspace_share)
    
    Raises:
        ValueError: If no workspace is found for the user.
    
    Args:
        conn: Database connection
        user_id: The user ID
        workspace_uuid: Optional workspace UUID to resolve
        
    Returns:
        The workspace ID
    """
    # If a specific workspace UUID is requested, resolve it first
    if workspace_uuid:
        row = await conn.fetchrow("""
            SELECT g.id FROM workspace g
            LEFT JOIN workspace_share gs ON g.id = gs.workspace_id
            WHERE g.uuid::text = $1 AND g.active = TRUE
              AND (g.create_uid = $2 OR gs.user_id = $2)
        """, workspace_uuid, user_id)
        if row:
            return row['id']
    
    # Check for existing workspace owned by user
    row = await conn.fetchrow("""
        SELECT id FROM workspace
        WHERE create_uid = $1 AND active = TRUE
        ORDER BY create_date ASC
        LIMIT 1
    """, user_id)
    
    if row:
        return row['id']
    
    # Check for workspaces shared with user
    row = await conn.fetchrow("""
        SELECT g.id FROM workspace g
        JOIN workspace_share gs ON g.id = gs.workspace_id
        WHERE gs.user_id = $1 AND gs.active = TRUE AND gs.can_read = TRUE AND g.active = TRUE
        ORDER BY g.create_date ASC
        LIMIT 1
    """, user_id)
    
    if row:
        return row['id']
    
    raise ValueError(f"No workspace found for user {user_id}")
