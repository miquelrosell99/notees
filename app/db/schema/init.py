"""Database initialization and seeding functions for Notees.

This module contains functions for initializing the database schema
and seeding workspaces with system data.
"""
from __future__ import annotations

import asyncpg
from datetime import datetime, timezone

from ...domain.entities import generate_uuid
from .constants import (
    SCHEMA_VERSION,
    SYSTEM_TYPES,
    SYSTEM_TYPE_UUIDS,
    SYSTEM_TYPE_ICONS,
    SYSTEM_PROPERTY_UUIDS,
    DEFAULT_PAGES,
)
from .sql import SCHEMA_SQL


async def init_database(conn: asyncpg.Connection) -> None:
    """Initialize the database with schema.
    
    This creates all tables, indexes, and triggers.
    Call this during application startup.
    """
    # Execute schema
    await conn.execute(SCHEMA_SQL)
    
    # Store schema version
    await conn.execute("""
        INSERT INTO schema_meta (key, value, updated_at) 
        VALUES ('version', $1, NOW())
        ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()
    """, str(SCHEMA_VERSION))


async def seed_workspace(conn: asyncpg.Connection, workspace_id: int) -> None:
    """Seed a workspace with system types, properties, and default pages.
    
    This should be called when creating a new workspace.
    """
    now = datetime.now(timezone.utc)
    
    # Helper to assign a relation property value
    async def assign_relation_property(node_id: int, property_id: int, target_node_id: int, order: int = 0):
        # Create or get node_property assignment
        await conn.execute("""
            INSERT INTO node_property (node_id, property_id, create_date, write_date)
            VALUES ($1, $2, $3, $3)
            ON CONFLICT (node_id, property_id) DO NOTHING
        """, node_id, property_id, now)
        
        # Get node_property id
        np_row = await conn.fetchrow(
            "SELECT id FROM node_property WHERE node_id = $1 AND property_id = $2",
            node_id, property_id
        )
        if np_row is None:
            raise RuntimeError(f"node_property not found for node_id={node_id}, property_id={property_id}")
        node_property_id = np_row['id']
        
        # Insert the relation value
        await conn.execute("""
            INSERT INTO property_value_relation 
            (node_property_id, property_id, node_id, target_node_id, "order", create_date, write_date)
            VALUES ($1, $2, $3, $4, $5, $6, $6)
        """, node_property_id, property_id, node_id, target_node_id, order, now)
    
    # Create 'type' node
    type_uuid = SYSTEM_TYPE_UUIDS["type"]
    type_row = await conn.fetchrow("""
        INSERT INTO node (uuid, workspace_id, name, is_type, is_page, create_date, write_date)
        VALUES ($1, $2, 'type', TRUE, TRUE, $3, $3)
        RETURNING id
    """, type_uuid, workspace_id, now)
    if type_row is None:
        raise RuntimeError("Failed to create 'type' node")
    type_node_id = type_row['id']
    
    # Create 'page' type node
    page_uuid = SYSTEM_TYPE_UUIDS["page"]
    page_row = await conn.fetchrow("""
        INSERT INTO node (uuid, workspace_id, name, is_type, is_page, create_date, write_date)
        VALUES ($1, $2, 'page', TRUE, TRUE, $3, $3)
        RETURNING id
    """, page_uuid, workspace_id, now)
    if page_row is None:
        raise RuntimeError("Failed to create 'page' node")
    page_type_id = page_row['id']
    
    # Create 'types' property (global, not workspace-specific for now)
    types_prop_uuid = SYSTEM_PROPERTY_UUIDS["types"]
    types_row = await conn.fetchrow("""
        INSERT INTO property (uuid, name, type, is_multi, is_system, create_date, write_date)
        VALUES ($1, 'types', 'node', TRUE, TRUE, $2, $2)
        ON CONFLICT (uuid) DO UPDATE SET uuid = EXCLUDED.uuid
        RETURNING id
    """, types_prop_uuid, now)
    if types_row is None:
        raise RuntimeError("Failed to create 'types' property")
    types_property_id = types_row['id']
    
    # Set type filter for 'types' property
    await conn.execute("""
        INSERT INTO property_type_filter (property_id, type_node_id)
        VALUES ($1, $2)
        ON CONFLICT DO NOTHING
    """, types_property_id, type_node_id)
    
    # Create other system properties
    show_hier_uuid = SYSTEM_PROPERTY_UUIDS["show_hierarchy"]
    await conn.execute("""
        INSERT INTO property (uuid, name, type, is_multi, is_system, create_date, write_date)
        VALUES ($1, 'show_hierarchy', 'boolean', FALSE, TRUE, $2, $2)
        ON CONFLICT (uuid) DO NOTHING
    """, show_hier_uuid, now)
    
    # Create 'cover' property
    cover_uuid = SYSTEM_PROPERTY_UUIDS["cover"]
    cover_row = await conn.fetchrow("""
        INSERT INTO property (uuid, name, type, is_multi, is_system, create_date, write_date)
        VALUES ($1, 'cover', 'image', FALSE, TRUE, $2, $2)
        ON CONFLICT (uuid) DO UPDATE SET uuid = EXCLUDED.uuid
        RETURNING id
    """, cover_uuid, now)
    if cover_row is None:
        raise RuntimeError("Failed to create 'cover' property")
    cover_property_id = cover_row['id']
    
    # Create 'banner' property
    banner_uuid = SYSTEM_PROPERTY_UUIDS["banner"]
    banner_row = await conn.fetchrow("""
        INSERT INTO property (uuid, name, type, is_multi, is_system, create_date, write_date)
        VALUES ($1, 'banner', 'image', FALSE, TRUE, $2, $2)
        ON CONFLICT (uuid) DO UPDATE SET uuid = EXCLUDED.uuid
        RETURNING id
    """, banner_uuid, now)
    if banner_row is None:
        raise RuntimeError("Failed to create 'banner' property")
    banner_property_id = banner_row['id']
    
    # Assign types to 'type' node
    await assign_relation_property(type_node_id, types_property_id, type_node_id, 0)
    await assign_relation_property(type_node_id, types_property_id, page_type_id, 1)
    
    # Assign types to 'page' node
    await assign_relation_property(page_type_id, types_property_id, type_node_id, 0)
    await assign_relation_property(page_type_id, types_property_id, page_type_id, 1)
    
    # Create remaining system types
    asset_type_id = None
    
    for type_name in SYSTEM_TYPES:
        if type_name in ("type", "page"):
            continue
        
        type_uuid = SYSTEM_TYPE_UUIDS.get(type_name, generate_uuid())
        type_icon = SYSTEM_TYPE_ICONS.get(type_name)
        
        row = await conn.fetchrow("""
            INSERT INTO node (uuid, workspace_id, name, icon, is_type, is_page, create_date, write_date)
            VALUES ($1, $2, $3, $4, TRUE, TRUE, $5, $5)
            RETURNING id
        """, type_uuid, workspace_id, type_name, type_icon, now)
        if row is None:
            raise RuntimeError(f"Failed to create '{type_name}' type node")
        new_type_id = row['id']
        
        if type_name == "asset":
            asset_type_id = new_type_id
        
        # Assign 'type' and 'page' types
        await assign_relation_property(new_type_id, types_property_id, type_node_id, 0)
        await assign_relation_property(new_type_id, types_property_id, page_type_id, 1)
    
    # Set type filter for 'cover' and 'banner' properties
    if asset_type_id:
        await conn.execute("""
            INSERT INTO property_type_filter (property_id, type_node_id)
            VALUES ($1, $2)
            ON CONFLICT DO NOTHING
        """, cover_property_id, asset_type_id)
        await conn.execute("""
            INSERT INTO property_type_filter (property_id, type_node_id)
            VALUES ($1, $2)
            ON CONFLICT DO NOTHING
        """, banner_property_id, asset_type_id)
    
    # Create default pages
    for page_name in DEFAULT_PAGES:
        row = await conn.fetchrow("""
            INSERT INTO node (uuid, workspace_id, name, is_page, create_date, write_date)
            VALUES ($1, $2, $3, TRUE, $4, $4)
            RETURNING id
        """, generate_uuid(), workspace_id, page_name, now)
        if row is None:
            raise RuntimeError(f"Failed to create '{page_name}' page")
        new_page_id = row['id']
        
        # Assign 'page' type
        await assign_relation_property(new_page_id, types_property_id, page_type_id, 0)


async def create_workspace_for_user(
    conn: asyncpg.Connection,
    user_id: int,
    name: str = "Default"
) -> int:
    """Create a new workspace for a user and seed it with system data.
    
    Returns the workspace ID.
    """
    now = datetime.now(timezone.utc)
    
    # Create workspace
    row = await conn.fetchrow("""
        INSERT INTO workspace (name, owner_id, create_date, write_date)
        VALUES ($1, $2, $3, $3)
        RETURNING id
    """, name, user_id, now)
    if row is None:
        raise RuntimeError("Failed to create workspace")
    workspace_id = row['id']
    
    # Add owner as workspace member
    await conn.execute("""
        INSERT INTO workspace_member (workspace_id, user_id, role, create_date)
        VALUES ($1, $2, 'owner', $3)
    """, workspace_id, user_id, now)
    
    # Seed workspace with system data
    await seed_workspace(conn, workspace_id)
    
    return workspace_id


async def get_or_create_user_workspace(
    conn: asyncpg.Connection,
    user_id: int
) -> int:
    """Get the user's default workspace or create one if it doesn't exist.
    
    Returns the workspace ID.
    """
    # Check for existing workspace
    row = await conn.fetchrow("""
        SELECT w.id FROM workspace w
        JOIN workspace_member wm ON w.id = wm.workspace_id
        WHERE wm.user_id = $1
        ORDER BY w.create_date ASC
        LIMIT 1
    """, user_id)
    
    if row:
        return row['id']
    
    # Create new workspace
    return await create_workspace_for_user(conn, user_id)
