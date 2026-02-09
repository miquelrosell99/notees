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
    SYSTEM_CLASSES,
    SYSTEM_CLASS_UUIDS,
    SYSTEM_CLASS_ICONS,
    SYSTEM_PROPERTY_UUIDS,
    DEFAULT_PAGES,
)
from .sql import SCHEMA_SQL


async def init_database(conn: asyncpg.Connection) -> None:
    """Initialize the database with schema.
    
    This creates all tables, indexes, and triggers.
    Call this during application startup.
    """
    # Execute schema (creates tables if they don't exist)
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
    
    # Create 'class' node (renamed from 'type')
    class_uuid = SYSTEM_CLASS_UUIDS["class"]
    class_icon = SYSTEM_CLASS_ICONS.get("class")
    class_row = await conn.fetchrow("""
        INSERT INTO node (uuid, graph_id, name, icon, is_class, is_page, create_date, write_date, create_uid, write_uid)
        VALUES ($1, $2, 'class', $3, TRUE, TRUE, $4, $4, $5, $5)
        RETURNING id
    """, class_uuid, graph_id, class_icon, now, user_id)
    if class_row is None:
        raise RuntimeError("Failed to create 'class' node")
    class_node_id = class_row['id']
    
    # Create 'page' class node
    page_uuid = SYSTEM_CLASS_UUIDS["page"]
    page_row = await conn.fetchrow("""
        INSERT INTO node (uuid, graph_id, name, is_class, is_page, create_date, write_date, create_uid, write_uid)
        VALUES ($1, $2, 'page', TRUE, TRUE, $3, $3, $4, $4)
        RETURNING id
    """, page_uuid, graph_id, now, user_id)
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
        INSERT INTO property (uuid, graph_id, name, type, is_multi, is_system, create_date, write_date, create_uid, write_uid)
        VALUES ($1, $2, 'Show hierarchy', 'boolean', FALSE, TRUE, $3, $3, $4, $4)
        ON CONFLICT (graph_id, uuid) DO NOTHING
    """, show_hier_uuid, graph_id, now, user_id)
    
    # Create 'Cover' property
    cover_uuid = SYSTEM_PROPERTY_UUIDS["cover"]
    cover_row = await conn.fetchrow("""
        INSERT INTO property (uuid, graph_id, name, type, is_multi, is_system, create_date, write_date, create_uid, write_uid)
        VALUES ($1, $2, 'Cover', 'image', FALSE, TRUE, $3, $3, $4, $4)
        ON CONFLICT (graph_id, uuid) DO UPDATE SET uuid = EXCLUDED.uuid
        RETURNING id
    """, cover_uuid, graph_id, now, user_id)
    if cover_row is None:
        raise RuntimeError("Failed to create 'Cover' property")
    cover_property_id = cover_row['id']
    
    # Create 'Banner' property
    banner_uuid = SYSTEM_PROPERTY_UUIDS["banner"]
    banner_row = await conn.fetchrow("""
        INSERT INTO property (uuid, graph_id, name, type, is_multi, is_system, create_date, write_date, create_uid, write_uid)
        VALUES ($1, $2, 'Banner', 'image', FALSE, TRUE, $3, $3, $4, $4)
        ON CONFLICT (graph_id, uuid) DO UPDATE SET uuid = EXCLUDED.uuid
        RETURNING id
    """, banner_uuid, graph_id, now, user_id)
    if banner_row is None:
        raise RuntimeError("Failed to create 'Banner' property")
    banner_property_id = banner_row['id']
    
    # Note: 'extends' property removed - class inheritance now uses class_extend table directly
    
    # Create remaining system classes
    asset_type_id = None
    
    for class_name in SYSTEM_CLASSES:
        if class_name in ("class", "page"):
            continue
        
        class_uuid = SYSTEM_CLASS_UUIDS.get(class_name, generate_uuid())
        class_icon = SYSTEM_CLASS_ICONS.get(class_name)
        
        row = await conn.fetchrow("""
            INSERT INTO node (uuid, graph_id, name, icon, is_class, is_page, create_date, write_date, create_uid, write_uid)
            VALUES ($1, $2, $3, $4, TRUE, TRUE, $5, $5, $6, $6)
            RETURNING id
        """, class_uuid, graph_id, class_name, class_icon, now, user_id)
        if row is None:
            raise RuntimeError(f"Failed to create '{class_name}' class node")
        new_class_id = row['id']
        
        if class_name == "asset":
            asset_type_id = new_class_id
        
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
        
        # Assign 'page' class using direct UPDATE to class_ids column
        await conn.execute("""
            UPDATE node SET class_ids = $1 WHERE id = $2
        """, [page_class_id], new_page_id)


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
