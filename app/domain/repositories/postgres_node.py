"""PostgreSQL implementation of Node repository."""
from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Optional, List, Any, TYPE_CHECKING, Union

import asyncpg
from asyncpg import Connection
from asyncpg.pool import PoolConnectionProxy

from ..entities import Node, NodeCreateData, NodeUpdateData, generate_uuid
from ..errors import OptimisticLockError
from ..permissions import PermissionChecker
from .interfaces import NodeRepository
from .base import normalize_timestamp
from ...utils import utc_now
from ...db.connection import acquire_connection

if TYPE_CHECKING:
    pass

# Type alias for connection types
ConnectionType = Union[Connection, PoolConnectionProxy]

from ..stringify_ast import parse_ast, serialize_ast, ParseMode


def _normalize_name_to_ast(name: Optional[str]) -> Optional[str]:
    """Normalize a name to AST format. Plain text is parsed for inline
    Markdown and converted to AST JSON."""
    if name is None or name == "":
        return name
    # Try JSON first — if it's valid AST, return as-is
    ast = parse_ast(name, ParseMode.JSON)
    if ast:
        return name
    # Plain text — parse inline Markdown into AST
    return serialize_ast(parse_ast(name, ParseMode.MARKDOWN))


class PostgresNodeRepository(NodeRepository):
    """PostgreSQL implementation of the NodeRepository.
    
    Supports:
    - Multi-tenant workspaces
    - Permission checking via ownership and shares
    - Optimistic locking via version column
    - Full-text search
    - Hierarchical queries with CTEs
    """
    
    def __init__(
        self, 
        pool: asyncpg.Pool,
        workspace_id: int,
        page_type_id: int,
        user_id: Optional[int] = None
    ):
        """Initialize with connection pool and workspace context.
        
        Args:
            pool: asyncpg connection pool
            workspace_id: Current workspace ID for multi-tenant queries
            page_type_id: ID of the 'page' type node
            user_id: Current user ID for permission checks and audit
        """
        self._pool = pool
        self._workspace_id = workspace_id
        self._page_class_id = page_type_id
        self._user_id = user_id
        self._permissions: Optional[PermissionChecker] = None
    
    @property
    def permissions(self) -> PermissionChecker:
        """Get permission checker, creating if needed."""
        if self._permissions is None and self._user_id is not None:
            self._permissions = PermissionChecker(self._pool, self._user_id)
        elif self._permissions is None:
            raise RuntimeError("User ID required for permission checks")
        return self._permissions
    
    def get_connection(self) -> asyncpg.Pool:
        """Get the underlying connection pool."""
        return self._pool
    
    def row_to_node(self, row: asyncpg.Record) -> Node:
        """Convert database row to Node entity (public interface)."""
        return self._row_to_node(row)
    
    def _row_to_node(self, row: asyncpg.Record) -> Node:
        """Convert database row to Node entity."""
        # Parse JSONB classes_path
        classes_path = row.get('classes_path', [])
        if classes_path is None:
            classes_path = []
        elif isinstance(classes_path, str):
            try:
                classes_path = json.loads(classes_path)
            except (json.JSONDecodeError, TypeError):
                classes_path = []
        
        # Parse class_ids array
        class_ids = row.get('class_ids', [])
        if class_ids is None:
            class_ids = []
        
        # Convert timestamps to ISO strings if they're datetime objects
        create_date = row['create_date']
        write_date = row['write_date']
        open_date = row.get('open_date')
        deleted_at = row.get('deleted_at')
        
        if isinstance(create_date, datetime):
            create_date = create_date.isoformat()
        if isinstance(write_date, datetime):
            write_date = write_date.isoformat()
        if isinstance(open_date, datetime):
            open_date = open_date.isoformat()
        if isinstance(deleted_at, datetime):
            deleted_at = deleted_at.isoformat()
        
        return Node(
            id=row['id'],
            uuid=str(row['uuid']),
            workspace_id=row.get('workspace_id'),
            name=row['name'],
            icon=row.get('icon'),
            color=row.get('color'),
            parent_id=row.get('parent_id'),
            page_id=row.get('page_id'),
            sequence=row.get('sequence', 0),
            collapsed=row.get('collapsed', False),
            active=row.get('active', True),
            is_shared=row.get('is_shared', False),
            is_deleted=row.get('is_deleted', False),
            deleted_at=deleted_at,
            is_class=row.get('is_class', False),
            is_page=row.get('is_page', False),
            is_day=row.get('is_day', False),
            is_month=row.get('is_month', False),
            is_year=row.get('is_year', False),
            is_asset=row.get('is_asset', False),
            is_template=row.get('is_template', False),
            is_comment=row.get('is_comment', False),
            open_date=open_date,
            create_date=create_date,
            write_date=write_date,
            create_uid=row.get('create_uid'),
            write_uid=row.get('write_uid'),
            class_ids=class_ids,
            classes_path=classes_path,
            version=row.get('version', 1),
            aliased_id=row.get('aliased_id'),
        )
    
    async def _compute_page_id(self, parent_id: int) -> Optional[int]:
        """Walk up parent chain to find containing page using closure table.
        
        Uses node_path for O(1) ancestor lookup instead of recursive CTE.
        """
        async with acquire_connection(self._pool) as conn:
            # Use node_path to find nearest page ancestor
            row = await conn.fetchrow("""
                SELECT n.id
                FROM node_path np
                JOIN node n ON n.id = np.ancestor_id
                WHERE np.descendant_id = $1 
                  AND n.is_page = TRUE 
                  AND n.workspace_id = $2
                  AND n.active = TRUE
                ORDER BY np.depth ASC
                LIMIT 1
            """, parent_id, self._workspace_id)
            return row['id'] if row else None
    
    async def _is_page(self, node_id: int) -> bool:
        """Check if a node is a page."""
        async with acquire_connection(self._pool) as conn:
            row = await conn.fetchrow(
                "SELECT is_page FROM node WHERE id = $1 AND workspace_id = $2",
                node_id, self._workspace_id
            )
            return row['is_page'] if row else False
    
    async def _shift_siblings_for_insert(self, conn: ConnectionType, parent_id: int, sequence: int) -> None:
        """Shift siblings at or after the given sequence to make room for insertion."""
        await conn.execute("""
            UPDATE node SET sequence = sequence + 1 
            WHERE parent_id = $1 AND sequence >= $2 AND workspace_id = $3
        """, parent_id, sequence, self._workspace_id)
    
    async def _close_sequence_gap(self, conn: ConnectionType, parent_id: int, old_sequence: int) -> None:
        """Close the gap left by a node that moved away."""
        await conn.execute("""
            UPDATE node SET sequence = sequence - 1 
            WHERE parent_id = $1 AND sequence > $2 AND workspace_id = $3
        """, parent_id, old_sequence, self._workspace_id)
    
    async def move(
        self,
        node_id: int,
        new_parent_id: Optional[int] = None,
        new_sequence: Optional[int] = None,
        user_id: Optional[int] = None
    ) -> Optional[Node]:
        """Move a node to a new parent and/or position with proper sibling resequencing."""
        # Permission check - need write permission on the node
        if self._user_id:
            await self.permissions.require_node_write(node_id)
        
        async with acquire_connection(self._pool) as conn:
            async with conn.transaction():
                node = await self.get_by_id(node_id)
                if not node:
                    return None
                
                old_parent_id = node.parent_id
                old_sequence = node.sequence
                now = utc_now()
                uid = user_id or self._user_id
                
                # Use existing values if not specified
                effective_parent_id = new_parent_id if new_parent_id is not None else old_parent_id
                effective_sequence = new_sequence if new_sequence is not None else old_sequence
                
                # Compute new page_id
                if effective_parent_id is not None and await self._is_page(effective_parent_id):
                    new_page_id = effective_parent_id
                else:
                    new_page_id = await self._compute_page_id(effective_parent_id) if effective_parent_id else None
                
                # Same parent - just resequence
                if old_parent_id == effective_parent_id:
                    if old_sequence == effective_sequence:
                        return node
                    
                    if old_sequence < effective_sequence:
                        await conn.execute("""
                            UPDATE node SET sequence = sequence - 1 
                            WHERE parent_id = $1 AND sequence > $2 AND sequence <= $3 
                            AND id != $4 AND workspace_id = $5
                        """, effective_parent_id, old_sequence, effective_sequence, node_id, self._workspace_id)
                    else:
                        await conn.execute("""
                            UPDATE node SET sequence = sequence + 1 
                            WHERE parent_id = $1 AND sequence >= $2 AND sequence < $3 
                            AND id != $4 AND workspace_id = $5
                        """, effective_parent_id, effective_sequence, old_sequence, node_id, self._workspace_id)
                else:
                    if old_parent_id is not None:
                        await self._close_sequence_gap(conn, old_parent_id, old_sequence)
                    if effective_parent_id is not None:
                        await self._shift_siblings_for_insert(conn, effective_parent_id, effective_sequence)
                
                # Update the node
                await conn.execute("""
                    UPDATE node 
                    SET parent_id = $1, page_id = $2, sequence = $3, 
                        write_date = $4, write_uid = $5, version = version + 1
                    WHERE id = $6 AND workspace_id = $7
                """, effective_parent_id, new_page_id, effective_sequence, now, uid, node_id, self._workspace_id)
                
                return await self.get_by_id(node_id)
    
    async def create(
        self,
        data: NodeCreateData,
        user_id: Optional[int] = None,
        uuid: Optional[str] = None
    ) -> Node:
        """Create a new node.
        
        Args:
            data: Node creation data
            user_id: Optional user ID override
            uuid: Optional UUID override (for date nodes, assets, etc.)
        """
        # Permission check - need create permission on workspace
        if self._user_id:
            await self.permissions.require_workspace_create(self._workspace_id)
        
        now = utc_now()
        uuid = uuid or data.uuid or generate_uuid()  # Use provided UUID or generate
        uid = user_id or self._user_id
        
        # Normalize name to AST format (converts plain text to AST if needed)
        normalized_name = _normalize_name_to_ast(data.name)
        
        # Compute page_id for blocks
        page_id = None
        if data.parent_id:
            if await self._is_page(data.parent_id):
                page_id = data.parent_id
            else:
                page_id = await self._compute_page_id(data.parent_id)
        
        # Compute is_* flags from classes (if any classes are provided)
        # These flags should NEVER be set directly - they are derived from classes
        is_class = False
        is_page = False
        is_day = False
        is_month = False
        is_year = False
        is_asset = False
        is_template = False
        is_comment = False
        
        if data.classes:
            from ...db.schema.constants import SYSTEM_CLASS_UUIDS
            
            # Map system class UUIDs to flag names
            class_uuid_to_flag = {
                SYSTEM_CLASS_UUIDS["class"]: "is_class",
                SYSTEM_CLASS_UUIDS["page"]: "is_page",
                SYSTEM_CLASS_UUIDS["day"]: "is_day",
                SYSTEM_CLASS_UUIDS["month"]: "is_month",
                SYSTEM_CLASS_UUIDS["year"]: "is_year",
                SYSTEM_CLASS_UUIDS["asset"]: "is_asset",
                SYSTEM_CLASS_UUIDS["template"]: "is_template",
                SYSTEM_CLASS_UUIDS["comment"]: "is_comment",
            }
            
            # Get UUIDs for all classes being assigned
            for class_id in data.classes:
                class_node = await self.get_by_id(class_id)
                if class_node and class_node.uuid in class_uuid_to_flag:
                    flag_name = class_uuid_to_flag[class_node.uuid]
                    if flag_name == "is_class":
                        is_class = True
                    elif flag_name == "is_page":
                        is_page = True
                    elif flag_name == "is_day":
                        is_day = True
                    elif flag_name == "is_month":
                        is_month = True
                    elif flag_name == "is_year":
                        is_year = True
                    elif flag_name == "is_asset":
                        is_asset = True
                    elif flag_name == "is_template":
                        is_template = True
                    elif flag_name == "is_comment":
                        is_comment = True
        
        async with acquire_connection(self._pool) as conn:
            async with conn.transaction():
                # Shift siblings if inserting at specific position
                if data.parent_id is not None and data.sequence is not None:
                    await self._shift_siblings_for_insert(conn, data.parent_id, data.sequence)
                
                # Insert node with class_ids
                row = await conn.fetchrow("""
                    INSERT INTO node (
                        uuid, workspace_id, name, icon, color, parent_id, page_id,
                        sequence, collapsed,
                        is_class, is_page, is_day, is_month, is_year,
                        is_asset, is_template, is_comment,
                        class_ids,
                        create_date, write_date, create_uid, write_uid
                    )
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $19, $20, $20)
                    RETURNING id
                """, uuid, self._workspace_id, normalized_name, data.icon, data.color,
                    data.parent_id, page_id, data.sequence, data.collapsed,
                    is_class, is_page, is_day,
                    is_month, is_year, is_asset,
                    is_template, is_comment,
                    data.classes if data.classes else [],
                    now, uid)
                
                if row is None:
                    raise RuntimeError("Failed to create node")
                node_id = row['id']
        
        return Node(
            id=node_id,
            uuid=uuid,
            workspace_id=self._workspace_id,
            name=normalized_name,
            icon=data.icon,
            color=data.color,
            parent_id=data.parent_id,
            page_id=page_id,
            sequence=data.sequence,
            collapsed=data.collapsed,
            active=True,
            is_class=is_class,
            is_page=is_page,
            is_day=is_day,
            is_month=is_month,
            is_year=is_year,
            is_asset=is_asset,
            class_ids=data.classes if data.classes else [],
            is_template=is_template,
            is_comment=is_comment,
            create_date=now.isoformat(),
            write_date=now.isoformat(),
            create_uid=uid,
            write_uid=uid,
            version=1,
        )
    
    async def get_by_id(self, node_id: int) -> Optional[Node]:
        """Get node by internal ID."""
        async with acquire_connection(self._pool) as conn:
            row = await conn.fetchrow(
                "SELECT * FROM node WHERE id = $1 AND workspace_id = $2 AND active = TRUE AND is_deleted = FALSE",
                node_id, self._workspace_id
            )
            if not row:
                return None
            
            # Permission check - need read permission
            if self._user_id:
                if not await self.permissions.can_read_node(node_id):
                    return None
            
            return self._row_to_node(row)
    
    async def get_by_ids(self, node_ids: List[int]) -> List[Node]:
        """Get multiple nodes by internal IDs in a single query.
        
        Returns nodes in no particular order. Missing/inaccessible IDs are silently skipped.
        """
        if not node_ids:
            return []
        
        async with acquire_connection(self._pool) as conn:
            rows = await conn.fetch(
                "SELECT * FROM node WHERE id = ANY($1) AND workspace_id = $2 AND active = TRUE AND is_deleted = FALSE",
                node_ids, self._workspace_id
            )
            return [self._row_to_node(row) for row in rows]
    
    async def get_by_uuid(self, uuid: str) -> Optional[Node]:
        """Get node by UUID."""
        async with acquire_connection(self._pool) as conn:
            row = await conn.fetchrow(
                "SELECT * FROM node WHERE uuid = $1 AND workspace_id = $2 AND active = TRUE AND is_deleted = FALSE",
                uuid, self._workspace_id
            )
            if not row:
                return None
            
            # Permission check - need read permission
            if self._user_id:
                if not await self.permissions.can_read_node(row['id']):
                    return None
            
            return self._row_to_node(row)
    
    async def update(
        self,
        node_id: int,
        data: NodeUpdateData,
        user_id: Optional[int] = None,
        expected_version: Optional[int] = None
    ) -> Optional[Node]:
        """Update a node with optimistic locking support.
        
        Args:
            node_id: Node to update
            data: Update data
            user_id: User making the change
            expected_version: If provided, update only if version matches
            
        Raises:
            OptimisticLockError: If version doesn't match
        """
        # Permission check - need write permission
        if self._user_id:
            await self.permissions.require_node_write(node_id)
        
        now = utc_now()
        uid = user_id or self._user_id
        
        # Build update query dynamically
        set_clauses = ["version = version + 1", "write_date = $1", "write_uid = $2"]
        params: List[Any] = [now, uid]
        param_idx = 3
        
        if data.name is not None:
            # Normalize name to AST format (converts plain text to AST if needed)
            normalized_name = _normalize_name_to_ast(data.name)
            set_clauses.append(f"name = ${param_idx}")
            params.append(normalized_name)
            param_idx += 1
        
        if data.icon is not None:
            set_clauses.append(f"icon = ${param_idx}")
            params.append(data.icon)
            param_idx += 1
        elif data.clear_icon:
            set_clauses.append(f"icon = NULL")
        
        if data.color is not None:
            set_clauses.append(f"color = ${param_idx}")
            params.append(data.color)
            param_idx += 1
        elif data.clear_color:
            set_clauses.append(f"color = NULL")
        
        if data.parent_id is not None:
            set_clauses.append(f"parent_id = ${param_idx}")
            params.append(data.parent_id)
            param_idx += 1
            # Recompute page_id
            if await self._is_page(data.parent_id):
                page_id = data.parent_id
            else:
                page_id = await self._compute_page_id(data.parent_id)
            set_clauses.append(f"page_id = ${param_idx}")
            params.append(page_id)
            param_idx += 1
        
        if data.sequence is not None:
            set_clauses.append(f"sequence = ${param_idx}")
            params.append(data.sequence)
            param_idx += 1
        
        if data.collapsed is not None:
            set_clauses.append(f"collapsed = ${param_idx}")
            params.append(data.collapsed)
            param_idx += 1
        
        # If classes are being updated, recompute all flags from the new classes
        if data.classes is not None:
            from ...db.schema.constants import SYSTEM_CLASS_UUIDS
            
            # Map system class UUIDs to flag names
            class_uuid_to_flag = {
                SYSTEM_CLASS_UUIDS["class"]: "is_class",
                SYSTEM_CLASS_UUIDS["page"]: "is_page",
                SYSTEM_CLASS_UUIDS["day"]: "is_day",
                SYSTEM_CLASS_UUIDS["month"]: "is_month",
                SYSTEM_CLASS_UUIDS["year"]: "is_year",
                SYSTEM_CLASS_UUIDS["asset"]: "is_asset",
                SYSTEM_CLASS_UUIDS["template"]: "is_template",
                SYSTEM_CLASS_UUIDS["comment"]: "is_comment",
            }
            
            # Reset all flags to False
            flags = {
                "is_class": False,
                "is_page": False,
                "is_day": False,
                "is_month": False,
                "is_year": False,
                "is_asset": False,
                "is_template": False,
                "is_comment": False,
            }
            
            # Get UUIDs for all classes being assigned
            for class_id in data.classes:
                class_node = await self.get_by_id(class_id)
                if class_node and class_node.uuid in class_uuid_to_flag:
                    flag_name = class_uuid_to_flag[class_node.uuid]
                    flags[flag_name] = True
            
            # Add flag updates to SET clause
            for flag_name, flag_value in flags.items():
                set_clauses.append(f"{flag_name} = ${param_idx}")
                params.append(flag_value)
                param_idx += 1
        
        # Build WHERE clause
        where_clause = f"id = ${param_idx} AND workspace_id = ${param_idx + 1}"
        params.append(node_id)
        params.append(self._workspace_id)
        param_idx += 2
        
        if expected_version is not None:
            where_clause += f" AND version = ${param_idx}"
            params.append(expected_version)
        
        query = f"""
            UPDATE node 
            SET {', '.join(set_clauses)}
            WHERE {where_clause}
            RETURNING *
        """
        
        async with acquire_connection(self._pool) as conn:
            row = await conn.fetchrow(query, *params)
            
            if row is None and expected_version is not None:
                # Check if node exists with different version
                check_row = await conn.fetchrow(
                    "SELECT version FROM node WHERE id = $1 AND workspace_id = $2",
                    node_id, self._workspace_id
                )
                if check_row:
                    raise OptimisticLockError(
                        node_id=node_id,
                        expected_version=expected_version,
                        actual_version=check_row['version']
                    )
            
            return self._row_to_node(row) if row else None
    
    async def delete(self, node_id: int) -> bool:
        """Delete a node and all its children (soft delete)."""
        # Permission check - need delete permission
        if self._user_id:
            await self.permissions.require_node_delete(node_id)
        
        async with acquire_connection(self._pool) as conn:
            # Use closure table (node_path) to get all descendants
            rows = await conn.fetch("""
                SELECT np.descendant_id as id
                FROM node_path np
                JOIN node n ON n.id = np.descendant_id
                WHERE np.ancestor_id = $1 AND n.workspace_id = $2
            """, node_id, self._workspace_id)
            
            if not rows:
                return False
            
            ids_to_delete = [row['id'] for row in rows]
            
            # Soft delete all nodes
            now = utc_now()
            await conn.execute("""
                UPDATE node SET active = FALSE, write_date = $1, write_uid = $2
                WHERE id = ANY($3) AND workspace_id = $4
            """, now, self._user_id, ids_to_delete, self._workspace_id)
            
            return True
    
    async def hard_delete(self, node_id: int) -> bool:
        """Permanently delete a node and all its children."""
        from app.logging_config import get_logger
        logger = get_logger(__name__)
        
        # Permission check - need delete permission
        if self._user_id:
            await self.permissions.require_node_delete(node_id)
        
        async with acquire_connection(self._pool) as conn:
            # Use closure table (node_path) to get all descendants
            rows = await conn.fetch("""
                SELECT np.descendant_id as id
                FROM node_path np
                JOIN node n ON n.id = np.descendant_id
                WHERE np.ancestor_id = $1 AND n.workspace_id = $2
            """, node_id, self._workspace_id)
            
            logger.info(f"[HARD_DELETE] node_id={node_id}, workspace_id={self._workspace_id}, found {len(rows)} descendants in node_path")
            
            if not rows:
                # Try direct delete if node_path has no entries
                logger.info(f"[HARD_DELETE] No node_path entries, trying direct delete")
                result = await conn.execute(
                    "DELETE FROM node WHERE id = $1 AND workspace_id = $2",
                    node_id, self._workspace_id
                )
                logger.info(f"[HARD_DELETE] Direct delete result: {result}")
                return "DELETE 1" in result
            
            ids_to_delete = [row['id'] for row in rows]
            logger.info(f"[HARD_DELETE] Deleting node ids: {ids_to_delete}")
            
            # Hard delete all nodes (cascades to property values, links)
            result = await conn.execute(
                "DELETE FROM node WHERE id = ANY($1) AND workspace_id = $2",
                ids_to_delete, self._workspace_id
            )
            logger.info(f"[HARD_DELETE] Delete result: {result}")
            
            return True
    
    async def get_children(self, parent_id: int) -> List[Node]:
        """Get direct children of a node."""
        async with acquire_connection(self._pool) as conn:
            rows = await conn.fetch(
                "SELECT * FROM node WHERE parent_id = $1 AND workspace_id = $2 AND active = TRUE AND is_deleted = FALSE ORDER BY sequence",
                parent_id, self._workspace_id
            )
            return [self._row_to_node(row) for row in rows]
    
    async def get_all_pages(self, limit: Optional[int] = None, offset: int = 0) -> List[Node]:
        """Get all active nodes tagged as 'page'.
        
        Args:
            limit: Maximum number of pages to return (default: no limit for backward compatibility)
            offset: Number of pages to skip (for pagination)
        """
        async with acquire_connection(self._pool) as conn:
            query = """
                SELECT * FROM node
                WHERE is_page = true AND active = true AND is_deleted = false AND workspace_id = $1
                ORDER BY write_date DESC NULLS LAST
            """
            params = [self._workspace_id]
            
            if limit is not None:
                query += " LIMIT $2 OFFSET $3"
                params.extend([limit, offset])
            
            rows = await conn.fetch(query, *params)
            return [self._row_to_node(row) for row in rows]
    
    async def get_page_content(self, page_id: int) -> List[Node]:
        """Get all nodes belonging to a page (recursive children)."""
        async with acquire_connection(self._pool) as conn:
            rows = await conn.fetch("""
                SELECT * FROM node
                WHERE (page_id = $1 OR id = $1) AND workspace_id = $2 AND active = TRUE AND is_deleted = FALSE
                ORDER BY sequence
            """, page_id, self._workspace_id)
            return [self._row_to_node(row) for row in rows]
    
    async def search(self, query: str, limit: int = 50) -> List[Node]:
        """Search nodes by name using full-text search.
        
        Extracts plain text from AST-formatted names for reliable ILIKE matching.
        """
        # SQL expression extracting plain text from AST-formatted name column
        name_text = """(CASE
            WHEN name IS NOT NULL AND name LIKE '[%' THEN
                COALESCE((SELECT string_agg(t #>> '{}', '') FROM jsonb_path_query(name::jsonb, '$.**.text') AS t), '')
            ELSE COALESCE(name, '')
        END)"""
        
        async with acquire_connection(self._pool) as conn:
            # Use FTS if query is substantial, fall back to ILIKE for short queries
            if len(query) >= 3:
                rows = await conn.fetch(f"""
                    SELECT *, ts_rank(search_vector, plainto_tsquery('english', $1)) AS rank
                    FROM node
                    WHERE workspace_id = $2 AND active = TRUE AND is_deleted = FALSE
                    AND (search_vector @@ plainto_tsquery('english', $1) OR {name_text} ILIKE $3)
                    ORDER BY rank DESC, write_date DESC
                    LIMIT $4
                """, query, self._workspace_id, f'%{query}%', limit)
            else:
                rows = await conn.fetch(f"""
                    SELECT * FROM node
                    WHERE {name_text} ILIKE $1
                    AND workspace_id = $2 AND active = TRUE AND is_deleted = FALSE
                    LIMIT $3
                """, f'%{query}%', self._workspace_id, limit)
            return [self._row_to_node(row) for row in rows]
    
    async def get_typed_with(self, type_node_id: int) -> List[Node]:
        """Get all nodes with a specific type."""
        async with acquire_connection(self._pool) as conn:
            rows = await conn.fetch("""
                SELECT n.* FROM node n
                WHERE $1 = ANY(n.class_ids) AND n.workspace_id = $2 AND n.active = TRUE AND n.is_deleted = FALSE
            """, type_node_id, self._workspace_id)
            return [self._row_to_node(row) for row in rows]
    
    async def set_active(self, node_id: int, active: bool, user_id: Optional[int] = None) -> Optional[Node]:
        """Set the active status of a node (archive/unarchive)."""
        # Permission check - need write permission
        if self._user_id:
            await self.permissions.require_node_write(node_id)
        
        now = utc_now()
        uid = user_id or self._user_id
        async with acquire_connection(self._pool) as conn:
            row = await conn.fetchrow("""
                UPDATE node 
                SET active = $1, write_date = $2, write_uid = $3, version = version + 1
                WHERE id = $4 AND workspace_id = $5
                RETURNING *
            """, active, now, uid, node_id, self._workspace_id)
            return self._row_to_node(row) if row else None
    
    async def get_archived_pages(self) -> List[Node]:
        """Get all archived nodes tagged as 'page'."""
        async with acquire_connection(self._pool) as conn:
            rows = await conn.fetch("""
                SELECT * FROM node
                WHERE is_page = true AND active = false 
                      AND (is_deleted = false OR is_deleted IS NULL)
                      AND workspace_id = $1
                ORDER BY write_date DESC NULLS LAST
            """, self._workspace_id)
            return [self._row_to_node(row) for row in rows]
    
    async def update_open_date(self, node_id: int) -> Optional[Node]:
        """Update the open_date timestamp for a node."""
        now = utc_now()
        async with acquire_connection(self._pool) as conn:
            row = await conn.fetchrow("""
                UPDATE node 
                SET open_date = $1
                WHERE id = $2 AND workspace_id = $3
                RETURNING *
            """, now, node_id, self._workspace_id)
            return self._row_to_node(row) if row else None

    # ============================================================
    # CLOSURE TABLE METHODS (node_path)
    # ============================================================
    # These methods use the node_path closure table for efficient
    # hierarchy queries without recursive CTEs.
    
    async def get_breadcrumbs(
        self,
        exit_node_id: int,
        enter_node_id: Optional[int] = None
    ) -> List[Node]:
        """Get the breadcrumb path for a node using the closure table.
        
        Returns ordered list of ancestor nodes from root (or enter_node) down to exit_node.
        Uses the get_breadcrumbs() Postgres function which queries node_path.
        
        Args:
            exit_node_id: The node to get breadcrumbs for
            enter_node_id: Optional starting ancestor (if None, starts from root)
            
        Returns:
            List of Node entities ordered from root/enter_node to exit_node
        """
        async with acquire_connection(self._pool) as conn:
            # Call the Postgres get_breadcrumbs function and join with full node data
            # to avoid N+1 queries
            if enter_node_id is not None:
                rows = await conn.fetch(
                    """
                    SELECT n.* 
                    FROM get_breadcrumbs($1, $2) AS bc
                    JOIN node n ON n.id = bc.id
                    WHERE n.workspace_id = $3
                    ORDER BY bc.depth DESC
                    """,
                    exit_node_id, enter_node_id, self._workspace_id
                )
            else:
                rows = await conn.fetch(
                    """
                    SELECT n.* 
                    FROM get_breadcrumbs($1) AS bc
                    JOIN node n ON n.id = bc.id
                    WHERE n.workspace_id = $2
                    ORDER BY bc.depth DESC
                    """,
                    exit_node_id, self._workspace_id
                )
            
            # Convert to Node entities in a single pass
            return [self._row_to_node(row) for row in rows]
    
    async def get_ancestors(
        self,
        node_id: int,
        include_self: bool = False
    ) -> List[int]:
        """Get all ancestor IDs of a node using the closure table.
        
        Uses node_path for O(1) lookup instead of recursive CTE.
        
        Args:
            node_id: The node to get ancestors for
            include_self: Whether to include the node itself in the result
            
        Returns:
            List of ancestor node IDs (ordered from root to immediate parent)
        """
        async with acquire_connection(self._pool) as conn:
            if include_self:
                rows = await conn.fetch("""
                    SELECT np.ancestor_id
                    FROM node_path np
                    JOIN node n ON n.id = np.ancestor_id
                    WHERE np.descendant_id = $1 AND n.workspace_id = $2 AND n.active = TRUE AND n.is_deleted = FALSE
                    ORDER BY np.depth DESC
                """, node_id, self._workspace_id)
            else:
                rows = await conn.fetch("""
                    SELECT np.ancestor_id
                    FROM node_path np
                    JOIN node n ON n.id = np.ancestor_id
                    WHERE np.descendant_id = $1 AND np.depth > 0 AND n.workspace_id = $2 AND n.active = TRUE AND n.is_deleted = FALSE
                    ORDER BY np.depth DESC
                """, node_id, self._workspace_id)
            
            return [row['ancestor_id'] for row in rows]
    
    async def get_descendants(
        self,
        node_id: int,
        include_self: bool = False
    ) -> List[int]:
        """Get all descendant IDs of a node using the closure table.
        
        Uses node_path for O(1) lookup instead of recursive CTE.
        
        Args:
            node_id: The node to get descendants for
            include_self: Whether to include the node itself in the result
            
        Returns:
            List of descendant node IDs (no specific order)
        """
        async with acquire_connection(self._pool) as conn:
            if include_self:
                rows = await conn.fetch("""
                    SELECT np.descendant_id
                    FROM node_path np
                    JOIN node n ON n.id = np.descendant_id
                    WHERE np.ancestor_id = $1 AND n.workspace_id = $2 AND n.active = TRUE AND n.is_deleted = FALSE
                """, node_id, self._workspace_id)
            else:
                rows = await conn.fetch("""
                    SELECT np.descendant_id
                    FROM node_path np
                    JOIN node n ON n.id = np.descendant_id
                    WHERE np.ancestor_id = $1 AND np.depth > 0 AND n.workspace_id = $2 AND n.active = TRUE AND n.is_deleted = FALSE
                """, node_id, self._workspace_id)
            
            return [row['descendant_id'] for row in rows]
