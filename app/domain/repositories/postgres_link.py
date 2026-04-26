"""PostgreSQL implementation of Link repository.

Updated for workspace-based schema:
- node_link table: source_id, target_id, is_tag, is_inline_class
- Inline class references are now stored in node_link with is_inline_class=TRUE
- All timestamps use create_date
- User tracking via create_uid
"""
from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import List, Optional

import asyncpg

from ..entities import NodeLink
from .interfaces import LinkRepository
from .base import normalize_timestamp
from ...utils import utc_now
from ...db.connection import acquire_connection


class PostgresLinkRepository(LinkRepository):
    """PostgreSQL implementation of the LinkRepository.
    
    Handles both regular node links and inline class references
    (distinguished by is_inline_class flag on node_link table).
    """
    
    def __init__(self, pool: asyncpg.Pool, workspace_id: int, user_id: Optional[int] = None):
        """Initialize with connection pool and workspace context.
        
        Args:
            pool: asyncpg connection pool
            workspace_id: The workspace this repository operates on
            user_id: Optional current user ID for audit trails
        """
        self._pool = pool
        self._workspace_id = workspace_id
        self._user_id = user_id
    
    def _row_to_link(self, row: asyncpg.Record) -> NodeLink:
        """Convert database row to NodeLink entity."""
        create_date = row['create_date']
        if isinstance(create_date, str):
            create_date = datetime.fromisoformat(create_date)
        return NodeLink(
            id=row['id'],
            source_id=row['source_id'],
            target_id=row['target_id'],
            uuid=str(row['uuid']) if row.get('uuid') else None,
            is_tag=row.get('is_tag', False),
            is_inline_class=row.get('is_inline_class', False),
            name=row.get('name'),
            create_date=create_date,
            create_uid=row.get('create_uid'),
        )
    
    async def create(self, link: NodeLink) -> NodeLink:
        """Create a new link."""
        async with acquire_connection(self._pool) as conn:
            if link.uuid:
                row = await conn.fetchrow("""
                    INSERT INTO node_link (uuid, source_id, target_id, is_tag, is_inline_class, name, create_date, create_uid, workspace_id)
                    VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9)
                    RETURNING id, uuid
                """, link.uuid, link.source_id, link.target_id, link.is_tag, link.is_inline_class,
                    link.name, link.create_date, link.create_uid or self._user_id, self._workspace_id)
            else:
                row = await conn.fetchrow("""
                    INSERT INTO node_link (source_id, target_id, is_tag, is_inline_class, name, create_date, create_uid, workspace_id)
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                    RETURNING id, uuid
                """, link.source_id, link.target_id, link.is_tag, link.is_inline_class,
                    link.name, link.create_date, link.create_uid or self._user_id, self._workspace_id)
            
            if row is None:
                raise RuntimeError("Failed to create link - no row returned")
            link.id = row['id']
            link.uuid = str(row['uuid'])
            return link
    
    async def delete_source_links(self, source_node_id: int) -> int:
        """Delete all links from a source node (for re-parsing)."""
        async with acquire_connection(self._pool) as conn:
            result = await conn.execute(
                "DELETE FROM node_link WHERE source_id = $1",
                source_node_id
            )
            # Parse "DELETE n" to get count
            return int(result.split()[-1]) if result else 0
    
    async def get_source_links(self, source_node_id: int) -> List[NodeLink]:
        """Get all links from a source node."""
        async with acquire_connection(self._pool) as conn:
            rows = await conn.fetch(
                "SELECT * FROM node_link WHERE source_id = $1",
                source_node_id
            )
            return [self._row_to_link(row) for row in rows]
    
    async def get_backlinks(self, target_node_id: int) -> List[NodeLink]:
        """Get all links pointing to a target node."""
        async with acquire_connection(self._pool) as conn:
            rows = await conn.fetch(
                "SELECT * FROM node_link WHERE target_id = $1",
                target_node_id
            )
            return [self._row_to_link(row) for row in rows]
    
    async def get_page_backlinks(self, page_id: int) -> List[NodeLink]:
        """Get backlinks with inheritance (links from nodes in this workspace)."""
        async with acquire_connection(self._pool) as conn:
            rows = await conn.fetch("""
                SELECT nl.*, n.page_id as source_page_id
                FROM node_link nl
                JOIN node n ON nl.source_id = n.id
                WHERE nl.target_id = $1 AND n.workspace_id = $2
            """, page_id, self._workspace_id)
            return [self._row_to_link(row) for row in rows]
    
    async def get_outgoing_links(self, source_node_id: int) -> List[NodeLink]:
        """Get all links from a source node."""
        async with acquire_connection(self._pool) as conn:
            rows = await conn.fetch(
                "SELECT * FROM node_link WHERE source_id = $1",
                source_node_id
            )
            return [self._row_to_link(row) for row in rows]
    
    def get_connection(self) -> asyncpg.Pool:
        """Get the underlying connection pool."""
        return self._pool
    
    async def bulk_create(self, links: List[NodeLink]) -> List[NodeLink]:
        """Create multiple links at once using COPY for efficiency."""
        if not links:
            return []
        
        async with acquire_connection(self._pool) as conn:
            # Use copy_records_to_table for best performance
            records = [
                (link.source_id, link.target_id, link.is_tag, link.is_inline_class,
                 link.create_date, link.create_uid or self._user_id)
                for link in links
            ]
            await conn.copy_records_to_table(
                'node_link',
                records=records,
                columns=['source_id', 'target_id', 'is_tag', 'is_inline_class',
                        'create_date', 'create_uid']
            )
        
        return links
    
    async def delete_text_links(self, source_node_id: int) -> int:
        """Delete all text links from a source node.
        
        Deletes non-tag, non-inline-class links from the source.
        """
        async with acquire_connection(self._pool) as conn:
            result = await conn.execute(
                "DELETE FROM node_link WHERE source_id = $1 AND is_tag = FALSE AND is_inline_class = FALSE",
                source_node_id
            )
            return int(result.split()[-1]) if result else 0
    
    async def delete_tag_links(self, source_node_id: int) -> int:
        """Delete all tag links from a source node."""
        async with acquire_connection(self._pool) as conn:
            result = await conn.execute(
                "DELETE FROM node_link WHERE source_id = $1 AND is_tag = TRUE",
                source_node_id
            )
            return int(result.split()[-1]) if result else 0
    
    async def get_backlinks_for_workspace(self, target_node_id: int) -> List[NodeLink]:
        """Get backlinks from nodes within the current workspace only."""
        async with acquire_connection(self._pool) as conn:
            rows = await conn.fetch("""
                SELECT nl.*
                FROM node_link nl
                JOIN node n ON nl.source_id = n.id
                WHERE nl.target_id = $1 AND n.workspace_id = $2
            """, target_node_id, self._workspace_id)
            return [self._row_to_link(row) for row in rows]
    
    # ============== Inline Class Methods ==============
    
    async def delete_source_inline_classes(self, source_node_id: int) -> int:
        """Delete all inline class links from a source node (for re-parsing)."""
        async with acquire_connection(self._pool) as conn:
            result = await conn.execute(
                "DELETE FROM node_link WHERE source_id = $1 AND is_inline_class = TRUE",
                source_node_id
            )
            return int(result.split()[-1]) if result else 0
    
    async def get_source_inline_classes(self, source_node_id: int) -> List[NodeLink]:
        """Get all inline class links from a source node."""
        async with acquire_connection(self._pool) as conn:
            rows = await conn.fetch(
                "SELECT * FROM node_link WHERE source_id = $1 AND is_inline_class = TRUE ORDER BY position",
                source_node_id
            )
            return [self._row_to_link(row) for row in rows]
    
    async def get_inline_class_references(self, target_node_id: int) -> List[NodeLink]:
        """Get all inline class links pointing to a target node."""
        async with acquire_connection(self._pool) as conn:
            rows = await conn.fetch(
                "SELECT * FROM node_link WHERE target_id = $1 AND is_inline_class = TRUE",
                target_node_id
            )
            return [self._row_to_link(row) for row in rows]
    
    async def get_inline_classes_for_workspace(self, target_node_id: int) -> List[NodeLink]:
        """Get inline class references from nodes within the current workspace only."""
        async with acquire_connection(self._pool) as conn:
            rows = await conn.fetch("""
                SELECT nl.*
                FROM node_link nl
                JOIN node n ON nl.source_id = n.id
                WHERE nl.target_id = $1 AND nl.is_inline_class = TRUE AND n.workspace_id = $2
            """, target_node_id, self._workspace_id)
            return [self._row_to_link(row) for row in rows]

    async def get_text_link_targets(self, source_node_id: int) -> List[int]:
        """Get target IDs of text links (non-tag, non-inline-class) from a source node."""
        async with acquire_connection(self._pool) as conn:
            rows = await conn.fetch(
                "SELECT target_id FROM node_link WHERE source_id = $1 AND property_id IS NULL",
                source_node_id
            )
            return [row['target_id'] for row in rows]
    
    async def get_tag_link_targets(self, source_node_id: int) -> List[int]:
        """Get target IDs of tag links from a source node."""
        async with acquire_connection(self._pool) as conn:
            rows = await conn.fetch(
                "SELECT target_id FROM node_link WHERE source_id = $1 AND property_id IS NULL AND is_tag = TRUE",
                source_node_id
            )
            return [row['target_id'] for row in rows]
    
    async def delete_non_tag_text_links(self, source_node_id: int) -> int:
        """Delete all non-tag, non-inline-class text links from a source node."""
        async with acquire_connection(self._pool) as conn:
            result = await conn.execute(
                "DELETE FROM node_link WHERE source_id = $1 AND property_id IS NULL AND is_tag = FALSE AND is_inline_class = FALSE",
                source_node_id
            )
            return int(result.split()[-1]) if result else 0
    
    async def ensure_tag_link(self, source_node_id: int, target_id: int) -> bool:
        """Ensure a tag link exists between source and target."""
        async with acquire_connection(self._pool) as conn:
            row = await conn.fetchrow(
                "SELECT id FROM node_link WHERE source_id = $1 AND target_id = $2 AND property_id IS NULL",
                source_node_id, target_id
            )
            if row:
                await conn.execute(
                    "UPDATE node_link SET is_tag = TRUE WHERE id = $1",
                    row['id']
                )
                return True
            return False
    
    async def clear_tag_link(self, source_node_id: int, target_id: int) -> bool:
        """Remove the tag flag from a link between source and target."""
        async with acquire_connection(self._pool) as conn:
            result = await conn.execute(
                "UPDATE node_link SET is_tag = FALSE WHERE source_id = $1 AND target_id = $2 AND property_id IS NULL AND is_tag = TRUE",
                source_node_id, target_id
            )
            return int(result.split()[-1]) > 0 if result else False
    
    async def delete_property_links(self, source_node_id: int, property_id: int) -> int:
        """Delete all links for a specific property from a source node."""
        async with acquire_connection(self._pool) as conn:
            result = await conn.execute(
                "DELETE FROM node_link WHERE source_id = $1 AND property_id = $2",
                source_node_id, property_id
            )
            return int(result.split()[-1]) if result else 0
    
    async def get_alias_node_ids(self, target_id: int) -> List[int]:
        """Get IDs of nodes that alias the target node."""
        async with acquire_connection(self._pool) as conn:
            rows = await conn.fetch(
                "SELECT id FROM node WHERE aliased_id = $1 AND active = TRUE AND (is_deleted = FALSE OR is_deleted IS NULL)",
                target_id
            )
            return [row['id'] for row in rows]
    
    async def get_backlinks_batch(self, target_ids: List[int]) -> List[asyncpg.Record]:
        """Get all node_link backlinks for multiple target IDs at once."""
        if not target_ids:
            return []
        async with acquire_connection(self._pool) as conn:
            return await conn.fetch("""
                SELECT nl.id, nl.source_id, nl.target_id, nl.position, nl.property_id, nl.create_date,
                       n.name as source_name, n.uuid as source_uuid, n.is_page as source_is_page,
                       n.page_id as source_page_id, p.name as property_name,
                       page.name as page_name, page.uuid as page_uuid
                FROM node_link nl
                JOIN node n ON nl.source_id = n.id
                LEFT JOIN property p ON nl.property_id = p.id
                LEFT JOIN node page ON n.page_id = page.id
                WHERE nl.target_id = ANY($1)
                  AND (n.is_deleted = FALSE OR n.is_deleted IS NULL)
                  AND (p.name IS NULL OR p.name NOT IN ('classes', 'extends'))
                  AND (nl.is_inline_class IS NULL OR nl.is_inline_class = FALSE)
            """, target_ids)
    
    async def get_property_backlinks_batch(self, target_ids: List[int]) -> List[asyncpg.Record]:
        """Get all property-value relation backlinks (node-type) for multiple targets."""
        if not target_ids:
            return []
        async with acquire_connection(self._pool) as conn:
            return await conn.fetch("""
                SELECT DISTINCT pvr.node_id as source_id, pvr.property_id,
                       n.name as source_name, n.uuid as source_uuid, n.is_page as source_is_page,
                       n.page_id as source_page_id, p.name as property_name,
                       page.name as page_name, page.uuid as page_uuid
                FROM property_value_relation pvr
                JOIN property p ON pvr.property_id = p.id
                JOIN node n ON pvr.node_id = n.id
                LEFT JOIN node page ON n.page_id = page.id
                WHERE pvr.target_id = ANY($1)
                  AND (n.is_deleted = FALSE OR n.is_deleted IS NULL)
                  AND p.type = 'node'
                  AND p.name NOT IN ('classes', 'extends')
            """, target_ids)
    
    async def get_text_property_backlinks_batch(self, target_ids: List[int]) -> List[asyncpg.Record]:
        """Get all text-type property backlinks for multiple targets."""
        if not target_ids:
            return []
        async with acquire_connection(self._pool) as conn:
            return await conn.fetch("""
                SELECT pvr.target_id AS root_block_id, pvr.node_id AS owner_id,
                       pvr.property_id, p.name AS property_name,
                       owner.name AS owner_name, owner.uuid AS owner_uuid,
                       owner.is_page AS owner_is_page, owner.page_id AS owner_page_id,
                       page.name AS owner_page_name, page.uuid AS owner_page_uuid
                FROM property_value_relation pvr
                JOIN property p ON pvr.property_id = p.id
                JOIN node owner ON pvr.node_id = owner.id
                LEFT JOIN node page ON owner.page_id = page.id
                WHERE pvr.target_id = ANY($1) AND p.type = 'text'
            """, target_ids)
    
    async def get_path_references(self, source_ids: List[int]) -> List[int]:
        """Get distinct target IDs referenced by any of the source nodes."""
        if not source_ids:
            return []
        async with acquire_connection(self._pool) as conn:
            rows = await conn.fetch(
                "SELECT DISTINCT nl.target_id FROM node_link nl WHERE nl.source_id = ANY($1)",
                source_ids
            )
            return [row['target_id'] for row in rows]
    
    async def get_node_class_ids(self, node_id: int) -> List[int]:
        """Get class_ids array for a node."""
        async with acquire_connection(self._pool) as conn:
            row = await conn.fetchrow(
                "SELECT class_ids FROM node WHERE id = $1", node_id
            )
            return row['class_ids'] if row and row['class_ids'] else []
    
    async def get_distinct_class_ids(self, node_ids: List[int]) -> List[int]:
        """Get all distinct class IDs from a list of nodes."""
        if not node_ids:
            return []
        async with acquire_connection(self._pool) as conn:
            rows = await conn.fetch(
                "SELECT DISTINCT unnest(class_ids) as class_id FROM node WHERE id = ANY($1) AND class_ids IS NOT NULL",
                node_ids
            )
            return [row['class_id'] for row in rows]
    
    async def bulk_update_classes_path(self, updates: List[tuple[List[int], int]]) -> None:
        """Bulk update classes_path for multiple nodes."""
        if not updates:
            return
        async with acquire_connection(self._pool) as conn:
            for classes_path, node_id in updates:
                await conn.execute(
                    "UPDATE node SET classes_path = $1::jsonb WHERE id = $2",
                    json.dumps(classes_path), node_id
                )
    
    async def get_inline_class_targets(self, source_node_id: int) -> List[int]:
        """Get target IDs of inline class links from a source node."""
        async with acquire_connection(self._pool) as conn:
            rows = await conn.fetch(
                "SELECT DISTINCT target_id FROM node_link WHERE source_id = $1 AND is_inline_class = TRUE",
                source_node_id
            )
            return [row['target_id'] for row in rows]
    
    async def log_link_activity(
        self, node_id: int, action: str, details: str,
        target_node_id: Optional[int], create_date: datetime
    ) -> None:
        """Log a link-related activity event."""
        async with acquire_connection(self._pool) as conn:
            await conn.execute(
                """INSERT INTO node_activity
                   (node_id, action, details, target_node_id, create_date)
                   VALUES ($1, $2, $3, $4, $5)""",
                node_id, action, details, target_node_id, create_date
            )

    async def get_backlink_source_ids(self, target_id: int) -> List[int]:
        """Get distinct source node IDs that link to the target."""
        async with acquire_connection(self._pool) as conn:
            rows = await conn.fetch(
                "SELECT DISTINCT source_id FROM node_link WHERE target_id = $1",
                target_id
            )
            return [row['source_id'] for row in rows]
    
    async def redirect_link_targets(self, old_target_id: int, new_target_id: int) -> None:
        """Update all node_link records to point from old_target to new_target."""
        async with acquire_connection(self._pool) as conn:
            await conn.execute(
                "UPDATE node_link SET target_id = $1 WHERE target_id = $2",
                new_target_id, old_target_id
            )
