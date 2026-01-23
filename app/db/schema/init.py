"""Database initialization and seeding functions for Notees.

This module contains functions for initializing the database schema
and seeding graphs with system data.

SCHEMA VERSION: 2 - Graph-based architecture.
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
    
    # Rebuild the node_path closure table to ensure consistency
    # This is idempotent and handles cases where nodes exist but node_path is empty
    await conn.execute("SELECT rebuild_node_path()")
    
    # Store schema version
    await conn.execute("""
        INSERT INTO schema_meta (key, value, updated_at) 
        VALUES ('version', $1, NOW())
        ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()
    """, str(SCHEMA_VERSION))


async def seed_graph(conn: asyncpg.Connection, graph_id: int, user_id: int) -> None:
    """Seed a graph with system types, properties, and default pages.
    
    This should be called when creating a new graph.
    
    Args:
        conn: Database connection
        graph_id: The ID of the graph to seed
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
    
    # Helper to assign a relation property value
    async def assign_relation_property(node_id: int, property_id: int, target_node_id: int):
        node_property_id = await get_or_create_node_property(node_id, property_id)
        await conn.execute("""
            INSERT INTO property_value_relation 
            (uuid, node_property_id, property_id, node_id, target_id, create_date, write_date, create_uid, write_uid)
            VALUES ($1, $2, $3, $4, $5, $6, $6, $7, $7)
        """, generate_uuid(), node_property_id, property_id, node_id, target_node_id, now, user_id)
    
    # Create 'type' node
    type_uuid = SYSTEM_TYPE_UUIDS["type"]
    type_row = await conn.fetchrow("""
        INSERT INTO node (uuid, graph_id, name, is_type, is_page, create_date, write_date, create_uid, write_uid)
        VALUES ($1, $2, 'type', TRUE, TRUE, $3, $3, $4, $4)
        RETURNING id
    """, type_uuid, graph_id, now, user_id)
    if type_row is None:
        raise RuntimeError("Failed to create 'type' node")
    type_node_id = type_row['id']
    
    # Create 'page' type node
    page_uuid = SYSTEM_TYPE_UUIDS["page"]
    page_row = await conn.fetchrow("""
        INSERT INTO node (uuid, graph_id, name, is_type, is_page, create_date, write_date, create_uid, write_uid)
        VALUES ($1, $2, 'page', TRUE, TRUE, $3, $3, $4, $4)
        RETURNING id
    """, page_uuid, graph_id, now, user_id)
    if page_row is None:
        raise RuntimeError("Failed to create 'page' node")
    page_type_id = page_row['id']
    
    # Create 'types' property (global, not graph-specific)
    types_prop_uuid = SYSTEM_PROPERTY_UUIDS["types"]
    types_row = await conn.fetchrow("""
        INSERT INTO property (uuid, name, type, is_multi, is_system, create_date, write_date, create_uid, write_uid)
        VALUES ($1, 'types', 'node', TRUE, TRUE, $2, $2, $3, $3)
        ON CONFLICT (uuid) DO UPDATE SET uuid = EXCLUDED.uuid
        RETURNING id
    """, types_prop_uuid, now, user_id)
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
        INSERT INTO property (uuid, name, type, is_multi, is_system, create_date, write_date, create_uid, write_uid)
        VALUES ($1, 'show_hierarchy', 'boolean', FALSE, TRUE, $2, $2, $3, $3)
        ON CONFLICT (uuid) DO NOTHING
    """, show_hier_uuid, now, user_id)
    
    # Create 'cover' property
    cover_uuid = SYSTEM_PROPERTY_UUIDS["cover"]
    cover_row = await conn.fetchrow("""
        INSERT INTO property (uuid, name, type, is_multi, is_system, create_date, write_date, create_uid, write_uid)
        VALUES ($1, 'cover', 'image', FALSE, TRUE, $2, $2, $3, $3)
        ON CONFLICT (uuid) DO UPDATE SET uuid = EXCLUDED.uuid
        RETURNING id
    """, cover_uuid, now, user_id)
    if cover_row is None:
        raise RuntimeError("Failed to create 'cover' property")
    cover_property_id = cover_row['id']
    
    # Create 'banner' property
    banner_uuid = SYSTEM_PROPERTY_UUIDS["banner"]
    banner_row = await conn.fetchrow("""
        INSERT INTO property (uuid, name, type, is_multi, is_system, create_date, write_date, create_uid, write_uid)
        VALUES ($1, 'banner', 'image', FALSE, TRUE, $2, $2, $3, $3)
        ON CONFLICT (uuid) DO UPDATE SET uuid = EXCLUDED.uuid
        RETURNING id
    """, banner_uuid, now, user_id)
    if banner_row is None:
        raise RuntimeError("Failed to create 'banner' property")
    banner_property_id = banner_row['id']
    
    # Assign types to 'type' node
    await assign_relation_property(type_node_id, types_property_id, type_node_id)
    await assign_relation_property(type_node_id, types_property_id, page_type_id)
    
    # Assign types to 'page' node
    await assign_relation_property(page_type_id, types_property_id, type_node_id)
    await assign_relation_property(page_type_id, types_property_id, page_type_id)
    
    # Create remaining system types
    asset_type_id = None
    
    for type_name in SYSTEM_TYPES:
        if type_name in ("type", "page"):
            continue
        
        type_uuid = SYSTEM_TYPE_UUIDS.get(type_name, generate_uuid())
        type_icon = SYSTEM_TYPE_ICONS.get(type_name)
        
        row = await conn.fetchrow("""
            INSERT INTO node (uuid, graph_id, name, icon, is_type, is_page, create_date, write_date, create_uid, write_uid)
            VALUES ($1, $2, $3, $4, TRUE, TRUE, $5, $5, $6, $6)
            RETURNING id
        """, type_uuid, graph_id, type_name, type_icon, now, user_id)
        if row is None:
            raise RuntimeError(f"Failed to create '{type_name}' type node")
        new_type_id = row['id']
        
        if type_name == "asset":
            asset_type_id = new_type_id
        
        # Assign 'type' and 'page' types
        await assign_relation_property(new_type_id, types_property_id, type_node_id)
        await assign_relation_property(new_type_id, types_property_id, page_type_id)
    
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
            INSERT INTO node (uuid, graph_id, name, is_page, create_date, write_date, create_uid, write_uid)
            VALUES ($1, $2, $3, TRUE, $4, $4, $5, $5)
            RETURNING id
        """, generate_uuid(), graph_id, page_name, now, user_id)
        if row is None:
            raise RuntimeError(f"Failed to create '{page_name}' page")
        new_page_id = row['id']
        
        # Assign 'page' type
        await assign_relation_property(new_page_id, types_property_id, page_type_id)


async def create_graph_for_user(
    conn: asyncpg.Connection,
    user_id: int,
    name: str = "Default"
) -> int:
    """Create a new graph for a user and seed it with system data.
    
    Args:
        conn: Database connection
        user_id: The user ID (owner of the graph)
        name: Name for the new graph (defaults to "Default")
        
    Returns:
        The graph ID
    """
    now = datetime.now(timezone.utc)
    
    # Create graph
    row = await conn.fetchrow("""
        INSERT INTO graph (name, create_uid, write_uid, create_date, write_date)
        VALUES ($1, $2, $2, $3, $3)
        RETURNING id
    """, name, user_id, now)
    if row is None:
        raise RuntimeError("Failed to create graph")
    graph_id = row['id']
    
    # Seed graph with system data
    await seed_graph(conn, graph_id, user_id)
    
    return graph_id


async def get_or_create_user_graph(
    conn: asyncpg.Connection,
    user_id: int
) -> int:
    """Get the user's default graph or create one if it doesn't exist.
    
    Checks for:
    1. Graphs owned by the user (create_uid)
    2. Graphs shared with the user (graph_share)
    
    If none found, creates a new graph.
    
    Args:
        conn: Database connection
        user_id: The user ID
        
    Returns:
        The graph ID
    """
    # Check for existing graph owned by user
    row = await conn.fetchrow("""
        SELECT id FROM graph
        WHERE create_uid = $1 AND active = TRUE
        ORDER BY create_date ASC
        LIMIT 1
    """, user_id)
    
    if row:
        return row['id']
    
    # Check for graphs shared with user
    row = await conn.fetchrow("""
        SELECT g.id FROM graph g
        JOIN graph_share gs ON g.id = gs.graph_id
        WHERE gs.user_id = $1 AND gs.active = TRUE AND gs.can_read = TRUE AND g.active = TRUE
        ORDER BY g.create_date ASC
        LIMIT 1
    """, user_id)
    
    if row:
        return row['id']
    
    # Create new graph
    return await create_graph_for_user(conn, user_id)


# ============== Legacy Aliases ==============
# These are kept for backward compatibility during migration

async def seed_workspace(conn: asyncpg.Connection, workspace_id: int, user_id: int | None = None) -> None:
    """Legacy alias for seed_graph.
    
    Deprecated: Use seed_graph instead.
    """
    # If user_id is not provided, try to get owner from graph
    if user_id is None:
        row = await conn.fetchrow("SELECT create_uid FROM graph WHERE id = $1", workspace_id)
        user_id = row['create_uid'] if row else 1
    await seed_graph(conn, workspace_id, user_id)


async def create_workspace_for_user(
    conn: asyncpg.Connection,
    user_id: int,
    name: str = "Default"
) -> int:
    """Legacy alias for create_graph_for_user.
    
    Deprecated: Use create_graph_for_user instead.
    """
    return await create_graph_for_user(conn, user_id, name)


async def get_or_create_user_workspace(
    conn: asyncpg.Connection,
    user_id: int
) -> int:
    """Legacy alias for get_or_create_user_graph.
    
    Deprecated: Use get_or_create_user_graph instead.
    """
    return await get_or_create_user_graph(conn, user_id)
