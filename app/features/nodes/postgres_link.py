"""PostgreSQL implementation of Link repository.

Updated for workspace-based schema:
- node_link table: source_id, target_id, is_inline_class
- Inline class references are now stored in node_link with is_inline_class=TRUE
- Tags are stored in node.tag_ids, not in node_link
- All timestamps use create_date
- User tracking via create_uid
"""

from __future__ import annotations

from datetime import datetime
from typing import Any

import asyncpg
from uuid_extensions import uuid7

from app.db.connection import acquire_connection
from app.domain.entities import NodeLink
from app.domain.repositories.base import BasePostgresRepository, normalize_timestamp
from app.features.nodes.port import LinkRepository


class PostgresLinkRepository(BasePostgresRepository, LinkRepository):
    """PostgreSQL implementation of the LinkRepository.

    Handles both regular node links and inline class references
    (distinguished by is_inline_class flag on node_link table).
    """

    def __init__(self, pool: asyncpg.Pool, workspace_id: int, user_id: int | None = None):
        """Initialize with connection pool and workspace context.

        Args:
            pool: asyncpg connection pool
            workspace_id: The workspace this repository operates on
            user_id: Optional current user ID for audit trails
        """
        super().__init__(pool, workspace_id, user_id)

    def _row_to_link(self, row: asyncpg.Record) -> NodeLink:
        """Convert database row to NodeLink entity."""
        create_date = normalize_timestamp(row["create_date"])
        return NodeLink(
            id=row["id"],
            source_id=row["source_id"],
            target_id=row["target_id"],
            uuid=str(row["uuid"]) if row.get("uuid") else None,
            is_inline_class=row.get("is_inline_class", False),
            is_embed=row.get("is_embed", False),
            name=row.get("name"),
            create_date=create_date,
            create_uid=row.get("create_uid"),
        )

    async def create(self, link: NodeLink) -> NodeLink:
        """Create a new link.

        If the caller supplies a ``link.uuid`` that already exists (for example
        a link copied client-side and pasted into a different block), the UUID
        is regenerated instead of failing the whole sync batch.
        """
        async with acquire_connection(self._pool) as conn:
            for _attempt in range(3):
                if link.uuid:
                    row = await conn.fetchrow(
                        """
                        INSERT INTO node_link (uuid, source_id, target_id, is_inline_class, is_embed, name, create_date, create_uid, workspace_id)
                        VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9)
                        ON CONFLICT (uuid) DO NOTHING
                        RETURNING id, uuid
                    """,
                        link.uuid,
                        link.source_id,
                        link.target_id,
                        link.is_inline_class,
                        link.is_embed,
                        link.name,
                        link.create_date,
                        link.create_uid or self._user_id,
                        self._workspace_id,
                    )
                    if row is None:
                        # UUID collision: generate a fresh one and retry.
                        link.uuid = str(uuid7())
                        continue
                else:
                    row = await conn.fetchrow(
                        """
                        INSERT INTO node_link (source_id, target_id, is_inline_class, is_embed, name, create_date, create_uid, workspace_id)
                        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                        RETURNING id, uuid
                    """,
                        link.source_id,
                        link.target_id,
                        link.is_inline_class,
                        link.is_embed,
                        link.name,
                        link.create_date,
                        link.create_uid or self._user_id,
                        self._workspace_id,
                    )

                if row is None:
                    raise RuntimeError("Failed to create link - no row returned")
                link.id = row["id"]
                link.uuid = str(row["uuid"])
                return link

            raise RuntimeError("Failed to create link after retrying UUID collisions")

    async def delete_source_links(self, source_node_id: int) -> int:
        """Delete all links from a source node (for re-parsing)."""
        async with acquire_connection(self._pool) as conn:
            result = await conn.execute(
                "DELETE FROM node_link WHERE source_id = $1 AND workspace_id = $2", source_node_id, self._workspace_id
            )
            # Parse "DELETE n" to get count
            return int(result.split()[-1]) if result else 0

    async def get_source_links(self, source_node_id: int) -> list[NodeLink]:
        """Get all links from a source node."""
        async with acquire_connection(self._pool) as conn:
            rows = await conn.fetch(
                "SELECT * FROM node_link WHERE source_id = $1 AND workspace_id = $2", source_node_id, self._workspace_id
            )
            return [self._row_to_link(row) for row in rows]

    async def get_backlinks(self, target_node_id: int) -> list[NodeLink]:
        """Get all links pointing to a target node."""
        async with acquire_connection(self._pool) as conn:
            rows = await conn.fetch(
                "SELECT * FROM node_link WHERE target_id = $1 AND workspace_id = $2", target_node_id, self._workspace_id
            )
            return [self._row_to_link(row) for row in rows]

    async def get_page_backlinks(self, page_id: int) -> list[NodeLink]:
        """Get backlinks with inheritance (links from nodes in this workspace)."""
        async with acquire_connection(self._pool) as conn:
            rows = await conn.fetch(
                """
                SELECT nl.*, n.page_id as source_page_id
                FROM node_link nl
                JOIN node n ON nl.source_id = n.id
                WHERE nl.target_id = $1 AND n.workspace_id = $2
                  AND (n.is_deleted = FALSE OR n.is_deleted IS NULL)
            """,
                page_id,
                self._workspace_id,
            )
            return [self._row_to_link(row) for row in rows]

    async def get_outgoing_links(self, source_node_id: int) -> list[NodeLink]:
        """Get all links from a source node."""
        async with acquire_connection(self._pool) as conn:
            rows = await conn.fetch(
                "SELECT * FROM node_link WHERE source_id = $1 AND workspace_id = $2", source_node_id, self._workspace_id
            )
            return [self._row_to_link(row) for row in rows]

    def get_connection(self) -> asyncpg.Pool:
        """Get the underlying connection pool."""
        return self._pool

    async def bulk_create(self, links: list[NodeLink]) -> list[NodeLink]:
        """Create multiple links at once using COPY for efficiency."""
        if not links:
            return []

        async with acquire_connection(self._pool) as conn:
            # Use copy_records_to_table for best performance
            records = [
                (
                    link.source_id,
                    link.target_id,
                    link.is_inline_class,
                    link.is_embed,
                    link.create_date,
                    link.create_uid or self._user_id,
                )
                for link in links
            ]
            await conn.copy_records_to_table(
                "node_link",
                records=records,
                columns=["source_id", "target_id", "is_inline_class", "is_embed", "create_date", "create_uid"],
            )

        return links

    async def delete_text_links(self, source_node_id: int) -> int:
        """Delete all text links from a source node.

        Deletes non-inline-class links from the source.
        """
        async with acquire_connection(self._pool) as conn:
            result = await conn.execute(
                "DELETE FROM node_link WHERE source_id = $1 AND is_inline_class = FALSE",
                source_node_id,
            )
            return int(result.split()[-1]) if result else 0

    async def get_backlinks_for_workspace(self, target_node_id: int) -> list[NodeLink]:
        """Get backlinks from nodes within the current workspace only."""
        async with acquire_connection(self._pool) as conn:
            rows = await conn.fetch(
                """
                SELECT nl.*
                FROM node_link nl
                JOIN node n ON nl.source_id = n.id
                WHERE nl.target_id = $1 AND n.workspace_id = $2
                  AND (n.is_deleted = FALSE OR n.is_deleted IS NULL)
            """,
                target_node_id,
                self._workspace_id,
            )
            return [self._row_to_link(row) for row in rows]

    # ============== Inline Class Methods ==============

    async def delete_source_inline_classes(self, source_node_id: int) -> int:
        """Delete all inline class links from a source node (for re-parsing)."""
        async with acquire_connection(self._pool) as conn:
            result = await conn.execute(
                "DELETE FROM node_link WHERE source_id = $1 AND is_inline_class = TRUE", source_node_id
            )
            return int(result.split()[-1]) if result else 0

    async def get_source_inline_classes(self, source_node_id: int) -> list[NodeLink]:
        """Get all inline class links from a source node."""
        async with acquire_connection(self._pool) as conn:
            rows = await conn.fetch(
                "SELECT * FROM node_link WHERE source_id = $1 AND is_inline_class = TRUE AND workspace_id = $2 ORDER BY position",
                source_node_id,
                self._workspace_id,
            )
            return [self._row_to_link(row) for row in rows]

    async def get_inline_class_references(self, target_node_id: int) -> list[NodeLink]:
        """Get all inline class links pointing to a target node."""
        async with acquire_connection(self._pool) as conn:
            rows = await conn.fetch(
                "SELECT * FROM node_link WHERE target_id = $1 AND is_inline_class = TRUE AND workspace_id = $2",
                target_node_id,
                self._workspace_id,
            )
            return [self._row_to_link(row) for row in rows]

    async def get_inline_classes_for_workspace(self, target_node_id: int) -> list[NodeLink]:
        """Get inline class references from nodes within the current workspace only."""
        async with acquire_connection(self._pool) as conn:
            rows = await conn.fetch(
                """
                SELECT nl.*
                FROM node_link nl
                JOIN node n ON nl.source_id = n.id
                WHERE nl.target_id = $1 AND nl.is_inline_class = TRUE AND n.workspace_id = $2
                  AND (n.is_deleted = FALSE OR n.is_deleted IS NULL)
            """,
                target_node_id,
                self._workspace_id,
            )
            return [self._row_to_link(row) for row in rows]

    async def get_text_link_targets(self, source_node_id: int) -> list[int]:
        """Get target IDs of text links (non-tag, non-inline-class) from a source node."""
        async with acquire_connection(self._pool) as conn:
            rows = await conn.fetch(
                "SELECT target_id FROM node_link WHERE source_id = $1 AND property_id IS NULL AND workspace_id = $2",
                source_node_id,
                self._workspace_id,
            )
            return [row["target_id"] for row in rows]

    async def delete_non_inline_class_text_links(self, source_node_id: int) -> int:
        """Delete all non-inline-class text links from a source node."""
        async with acquire_connection(self._pool) as conn:
            result = await conn.execute(
                "DELETE FROM node_link WHERE source_id = $1 AND property_id IS NULL AND is_inline_class = FALSE AND workspace_id = $2",
                source_node_id,
                self._workspace_id,
            )
            return int(result.split()[-1]) if result else 0

    async def delete_property_links(self, source_node_id: int, property_id: int) -> int:
        """Delete all links for a specific property from a source node."""
        async with acquire_connection(self._pool) as conn:
            result = await conn.execute(
                "DELETE FROM node_link WHERE source_id = $1 AND property_id = $2 AND workspace_id = $3",
                source_node_id,
                property_id,
                self._workspace_id,
            )
            return int(result.split()[-1]) if result else 0

    async def get_alias_node_ids(self, target_id: int) -> list[int]:
        """Get IDs of nodes that alias the target node."""
        async with acquire_connection(self._pool) as conn:
            rows = await conn.fetch(
                "SELECT id FROM node WHERE aliased_id = $1 AND active = TRUE AND (is_deleted = FALSE OR is_deleted IS NULL) AND workspace_id = $2",
                target_id,
                self._workspace_id,
            )
            return [row["id"] for row in rows]

    async def get_alias_node_ids_batch(self, target_ids: list[int]) -> dict[int, list[int]]:
        """Get alias node IDs for multiple target nodes."""
        if not target_ids:
            return {}
        async with acquire_connection(self._pool) as conn:
            rows = await conn.fetch(
                """
                SELECT aliased_id, id
                FROM node
                WHERE aliased_id = ANY($1) AND workspace_id = $2
                  AND active = TRUE AND (is_deleted = FALSE OR is_deleted IS NULL)
                ORDER BY aliased_id, name
            """,
                target_ids,
                self._workspace_id,
            )
            result: dict[int, list[int]] = {}
            for row in rows:
                result.setdefault(row["aliased_id"], []).append(row["id"])
            return result

    async def get_backlinks_batch(self, target_ids: list[int]) -> list[asyncpg.Record]:
        """Get all node_link backlinks for multiple target IDs at once."""
        if not target_ids:
            return []
        async with acquire_connection(self._pool) as conn:
            return await conn.fetch(
                """
                SELECT nl.id, nl.source_id, nl.target_id, nl.position, nl.property_id, nl.is_embed, nl.create_date,
                       n.name as source_name, n.uuid as source_uuid, n.is_page as source_is_page,
                       n.page_id as source_page_id, p.name as property_name,
                       page.name as page_name, page.uuid as page_uuid
                FROM node_link nl
                JOIN node n ON nl.source_id = n.id
                LEFT JOIN property p ON nl.property_id = p.id
                LEFT JOIN node page ON n.page_id = page.id
                WHERE nl.target_id = ANY($1) AND n.workspace_id = $2
                  AND (n.is_deleted = FALSE OR n.is_deleted IS NULL)
                  AND (p.name IS NULL OR p.name NOT IN ('classes', 'extends'))
                  AND (nl.is_inline_class IS NULL OR nl.is_inline_class = FALSE)
            """,
                target_ids,
                self._workspace_id,
            )

    async def get_property_backlinks_batch(self, target_ids: list[int]) -> list[asyncpg.Record]:
        """Get all property-value relation backlinks (node-type) for multiple targets."""
        if not target_ids:
            return []
        async with acquire_connection(self._pool) as conn:
            return await conn.fetch(
                """
                SELECT DISTINCT pvr.node_id as source_id, pvr.property_id,
                       n.name as source_name, n.uuid as source_uuid, n.is_page as source_is_page,
                       n.page_id as source_page_id, p.name as property_name,
                       page.name as page_name, page.uuid as page_uuid
                FROM property_value_relation pvr
                JOIN property p ON pvr.property_id = p.id
                JOIN node n ON pvr.node_id = n.id
                LEFT JOIN node page ON n.page_id = page.id
                WHERE pvr.target_id = ANY($1) AND n.workspace_id = $2
                  AND (n.is_deleted = FALSE OR n.is_deleted IS NULL)
                  AND p.type = 'node'
                  AND p.name NOT IN ('classes', 'extends')
            """,
                target_ids,
                self._workspace_id,
            )

    async def get_text_property_backlinks_batch(self, target_ids: list[int]) -> list[asyncpg.Record]:
        """Get all text-type property backlinks for multiple targets."""
        if not target_ids:
            return []
        async with acquire_connection(self._pool) as conn:
            return await conn.fetch(
                """
                SELECT pvr.target_id AS root_block_id, pvr.node_id AS owner_id,
                       pvr.property_id, p.name AS property_name,
                       owner.name AS owner_name, owner.uuid AS owner_uuid,
                       owner.is_page AS owner_is_page, owner.page_id AS owner_page_id,
                       page.name AS owner_page_name, page.uuid AS owner_page_uuid
                FROM property_value_relation pvr
                JOIN property p ON pvr.property_id = p.id
                JOIN node owner ON pvr.node_id = owner.id
                LEFT JOIN node page ON owner.page_id = page.id
                WHERE pvr.target_id = ANY($1) AND p.type = 'text' AND owner.workspace_id = $2
                  AND (owner.is_deleted = FALSE OR owner.is_deleted IS NULL)
            """,
                target_ids,
                self._workspace_id,
            )

    async def get_path_references(self, source_ids: list[int]) -> list[int]:
        """Get distinct target IDs referenced by any of the source nodes."""
        if not source_ids:
            return []
        async with acquire_connection(self._pool) as conn:
            rows = await conn.fetch(
                "SELECT DISTINCT nl.target_id FROM node_link nl WHERE nl.source_id = ANY($1) AND nl.workspace_id = $2",
                source_ids,
                self._workspace_id,
            )
            return [row["target_id"] for row in rows]

    async def get_text_link_targets_batch(self, source_ids: list[int]) -> list[int]:
        """Get distinct target IDs of text links from source nodes."""
        if not source_ids:
            return []
        async with acquire_connection(self._pool) as conn:
            rows = await conn.fetch(
                """
                SELECT DISTINCT nl.target_id
                FROM node_link nl
                WHERE nl.source_id = ANY($1)
                  AND nl.workspace_id = $2
                  AND nl.is_inline_class = FALSE
                  AND nl.property_id IS NULL
            """,
                source_ids,
                self._workspace_id,
            )
            return [row["target_id"] for row in rows]

    async def get_backlink_counts(self, target_ids: list[int]) -> dict[int, int]:
        """Get backlink counts for multiple target nodes."""
        if not target_ids:
            return {}
        async with acquire_connection(self._pool) as conn:
            rows = await conn.fetch(
                """
                SELECT target_id, COUNT(*) as count
                FROM node_link
                WHERE target_id = ANY($1) AND workspace_id = $2
                GROUP BY target_id
            """,
                target_ids,
                self._workspace_id,
            )
            return {row["target_id"]: row["count"] for row in rows}

    async def get_node_class_ids(self, node_id: int) -> list[int]:
        """Get class_ids array for a node."""
        async with acquire_connection(self._pool) as conn:
            row = await conn.fetchrow("SELECT class_ids FROM node WHERE id = $1 AND workspace_id = $2", node_id, self._workspace_id)
            return row["class_ids"] if row and row["class_ids"] else []

    async def get_distinct_class_ids(self, node_ids: list[int]) -> list[int]:
        """Get all distinct class IDs from a list of nodes."""
        if not node_ids:
            return []
        async with acquire_connection(self._pool) as conn:
            rows = await conn.fetch(
                "SELECT DISTINCT unnest(class_ids) as class_id FROM node WHERE id = ANY($1) AND class_ids IS NOT NULL AND workspace_id = $2",
                node_ids,
                self._workspace_id,
            )
            return [row["class_id"] for row in rows]

    async def bulk_update_classes_path(self, updates: list[tuple[list[int], int]]) -> None:
        """Bulk update classes_path for multiple nodes."""
        if not updates:
            return
        async with acquire_connection(self._pool) as conn:
            for classes_path, node_id in updates:
                await conn.execute(
                    "UPDATE node SET classes_path = $1::jsonb WHERE id = $2",
                    classes_path,
                    node_id,
                )

    async def get_inline_class_targets(self, source_node_id: int) -> list[int]:
        """Get target IDs of inline class links from a source node."""
        async with acquire_connection(self._pool) as conn:
            rows = await conn.fetch(
                "SELECT DISTINCT target_id FROM node_link WHERE source_id = $1 AND is_inline_class = TRUE AND workspace_id = $2",
                source_node_id,
                self._workspace_id,
            )
            return [row["target_id"] for row in rows]

    async def log_link_activity(
        self, node_id: int, action: str, details: str, target_node_id: int | None, create_date: datetime
    ) -> None:
        """Log a link-related activity event."""
        uid = self._user_id
        async with acquire_connection(self._pool) as conn:
            await conn.execute(
                """INSERT INTO node_activity
                   (node_id, action, details, target_node_id, user_id, create_uid, create_date)
                   VALUES ($1, $2, $3, $4, $5, $6, $7)""",
                node_id,
                action,
                details,
                target_node_id,
                uid,
                uid,
                create_date,
            )

    async def get_backlink_source_ids(self, target_id: int) -> list[int]:
        """Get distinct source node IDs that link to the target."""
        async with acquire_connection(self._pool) as conn:
            rows = await conn.fetch(
                "SELECT DISTINCT source_id FROM node_link WHERE target_id = $1 AND workspace_id = $2",
                target_id,
                self._workspace_id,
            )
            return [row["source_id"] for row in rows]

    async def redirect_link_targets(self, old_target_id: int, new_target_id: int) -> None:
        """Update all node_link records to point from old_target to new_target."""
        async with acquire_connection(self._pool) as conn:
            await conn.execute("UPDATE node_link SET target_id = $1 WHERE target_id = $2", new_target_id, old_target_id)

    async def get_text_links(self, source_node_id: int) -> list[NodeLink]:
        """Get all text links (property_id IS NULL) from a source node ordered by position."""
        async with acquire_connection(self._pool) as conn:
            rows = await conn.fetch(
                """
                SELECT id, uuid, source_id, target_id, position, name
                FROM node_link
                WHERE source_id = $1 AND property_id IS NULL AND workspace_id = $2
                ORDER BY position
            """,
                source_node_id,
                self._workspace_id,
            )
            return [self._row_to_link(row) for row in rows]

    async def get_text_links_batch(self, node_ids: list[int]) -> list[NodeLink]:
        """Get all text links for multiple source nodes ordered by source_id, position."""
        if not node_ids:
            return []
        async with acquire_connection(self._pool) as conn:
            rows = await conn.fetch(
                """
                SELECT id, uuid, source_id, target_id, position, name
                FROM node_link
                WHERE source_id = ANY($1) AND property_id IS NULL AND workspace_id = $2
                ORDER BY source_id, position
            """,
                node_ids,
                self._workspace_id,
            )
            return [self._row_to_link(row) for row in rows]

    async def get_property_backlinks_for_node(self, node_id: int) -> tuple[list[asyncpg.Record], list[asyncpg.Record]]:
        """Get property backlinks for a node: date properties and node properties."""
        async with acquire_connection(self._pool) as conn:
            date_rows = await conn.fetch(
                """
                SELECT DISTINCT pvr.node_id, pvr.property_id, p.name as property_name
                FROM property_value_relation pvr
                JOIN property p ON pvr.property_id = p.id
                WHERE pvr.target_id = $1 AND p.type = 'date'
            """,
                node_id,
            )
            node_rows = await conn.fetch(
                """
                SELECT DISTINCT pvr.node_id, pvr.property_id, p.name as property_name
                FROM property_value_relation pvr
                JOIN property p ON pvr.property_id = p.id
                WHERE pvr.target_id = $1 AND p.type = 'node'
            """,
                node_id,
            )
            return date_rows, node_rows

    async def set_alias(self, target_node_id: int, alias_node_id: int) -> str:
        """Set aliased_id on alias_node_id to target_node_id."""
        async with acquire_connection(self._pool) as conn:
            return await conn.execute("UPDATE node SET aliased_id = $1 WHERE id = $2", target_node_id, alias_node_id)

    async def remove_alias(self, target_node_id: int, alias_node_id: int) -> bool:
        """Clear aliased_id for an alias of target_node_id."""
        async with acquire_connection(self._pool) as conn:
            result = await conn.execute(
                "UPDATE node SET aliased_id = NULL WHERE id = $1 AND aliased_id = $2 AND workspace_id = $3",
                alias_node_id,
                target_node_id,
                self._workspace_id,
            )
            return result == "UPDATE 1"

    async def get_links_for_nodes(
        self,
        node_ids: list[int],
        scope: str,
        cooccurrence: bool,
        context_node_id: int | None,
    ) -> list[dict[str, Any]]:
        """Get links for a specific set of node IDs."""
        from collections import Counter, defaultdict

        node_id_set = set(node_ids)
        require_both = scope == "between"
        links: list[dict[str, Any]] = []

        async with acquire_connection(self._pool) as conn:
            # 1. Reference links (from node_link table, resolving blocks to pages)
            link_rows = await conn.fetch(
                """
                SELECT DISTINCT nl.source_id, nl.target_id
                FROM node_link nl
                JOIN node source ON nl.source_id = source.id
                JOIN node target ON nl.target_id = target.id
                WHERE source.workspace_id = $1
                  AND target.workspace_id = $1
                  AND target.is_page = TRUE
                  AND source.active = TRUE
                  AND target.active = TRUE
                  AND (nl.source_id = ANY($2::int[]) OR nl.target_id = ANY($2::int[]))
            """,
                self._workspace_id,
                node_ids,
            )

            block_source_ids = [row["source_id"] for row in link_rows if row["source_id"] not in node_id_set]
            block_to_page: dict[int, int] = {}
            if block_source_ids:
                block_rows = await conn.fetch(
                    "SELECT id, page_id FROM node WHERE id = ANY($1::int[])", block_source_ids
                )
                for br in block_rows:
                    if br["page_id"]:
                        block_to_page[br["id"]] = br["page_id"]

            for row in link_rows:
                source_page_id = row["source_id"]
                if source_page_id not in node_id_set:
                    source_page_id = block_to_page.get(source_page_id, source_page_id)
                target_id = row["target_id"]
                if require_both:
                    if source_page_id in node_id_set and target_id in node_id_set:
                        links.append({"source": source_page_id, "target": target_id, "type": "reference"})
                else:
                    if source_page_id in node_id_set or target_id in node_id_set:
                        links.append({"source": source_page_id, "target": target_id, "type": "reference"})

            # 2. Parent relationships
            if require_both:
                parent_rows = await conn.fetch(
                    """
                    SELECT child.id as child_id, parent.id as parent_id
                    FROM node child
                    JOIN node parent ON child.parent_id = parent.id
                    WHERE child.workspace_id = $1
                      AND child.is_page = TRUE
                      AND parent.is_page = TRUE
                      AND child.active = TRUE
                      AND parent.active = TRUE
                      AND child.id = ANY($2::int[])
                      AND parent.id = ANY($2::int[])
                """,
                    self._workspace_id,
                    node_ids,
                )
            else:
                parent_rows = await conn.fetch(
                    """
                    SELECT child.id as child_id, parent.id as parent_id
                    FROM node child
                    JOIN node parent ON child.parent_id = parent.id
                    WHERE child.workspace_id = $1
                      AND child.is_page = TRUE
                      AND parent.is_page = TRUE
                      AND child.active = TRUE
                      AND parent.active = TRUE
                      AND (child.id = ANY($2::int[]) OR parent.id = ANY($2::int[]))
                """,
                    self._workspace_id,
                    node_ids,
                )
            for row in parent_rows:
                links.append({"source": row["parent_id"], "target": row["child_id"], "type": "parent"})

            # 3. Class relationships from node.class_ids
            class_rows = await conn.fetch(
                """
                SELECT id, class_ids FROM node
                WHERE id = ANY($1::int[]) AND workspace_id = $2
            """,
                node_ids,
                self._workspace_id,
            )
            class_ids_map = {row["id"]: list(row["class_ids"] or []) for row in class_rows}
            for nid in node_ids:
                for class_id in class_ids_map.get(nid, []):
                    if not require_both or class_id in node_id_set:
                        links.append({"source": nid, "target": class_id, "type": "class"})

            # 4. Class extends (inheritance)
            if require_both:
                class_extends_rows = await conn.fetch(
                    """
                    SELECT ce.target_id as child_id, ce.source_id as parent_id
                    FROM class_extend ce
                    JOIN node child ON ce.target_id = child.id
                    JOIN node parent ON ce.source_id = parent.id
                    WHERE child.workspace_id = $1
                      AND parent.workspace_id = $1
                      AND child.active = TRUE
                      AND parent.active = TRUE
                      AND ce.target_id = ANY($2::int[])
                      AND ce.source_id = ANY($2::int[])
                """,
                    self._workspace_id,
                    node_ids,
                )
            else:
                class_extends_rows = await conn.fetch(
                    """
                    SELECT ce.target_id as child_id, ce.source_id as parent_id
                    FROM class_extend ce
                    JOIN node child ON ce.target_id = child.id
                    JOIN node parent ON ce.source_id = parent.id
                    WHERE child.workspace_id = $1
                      AND parent.workspace_id = $1
                      AND child.active = TRUE
                      AND parent.active = TRUE
                      AND (ce.target_id = ANY($2::int[]) OR ce.source_id = ANY($2::int[]))
                """,
                    self._workspace_id,
                    node_ids,
                )
            for row in class_extends_rows:
                links.append({"source": row["child_id"], "target": row["parent_id"], "type": "extends"})

            # 5. Property-based links
            if require_both:
                property_link_rows = await conn.fetch(
                    """
                    SELECT DISTINCT pvr.node_id, pvr.target_id
                    FROM property_value_relation pvr
                    JOIN node source ON pvr.node_id = source.id
                    JOIN node target ON pvr.target_id = target.id
                    WHERE source.workspace_id = $1
                      AND target.workspace_id = $1
                      AND source.is_page = TRUE
                      AND target.is_page = TRUE
                      AND source.active = TRUE
                      AND target.active = TRUE
                      AND pvr.node_id = ANY($2::int[])
                      AND pvr.target_id = ANY($2::int[])
                """,
                    self._workspace_id,
                    node_ids,
                )
            else:
                property_link_rows = await conn.fetch(
                    """
                    SELECT DISTINCT pvr.node_id, pvr.target_id
                    FROM property_value_relation pvr
                    JOIN node source ON pvr.node_id = source.id
                    JOIN node target ON pvr.target_id = target.id
                    WHERE source.workspace_id = $1
                      AND target.workspace_id = $1
                      AND source.is_page = TRUE
                      AND target.is_page = TRUE
                      AND source.active = TRUE
                      AND target.active = TRUE
                      AND (pvr.node_id = ANY($2::int[]) OR pvr.target_id = ANY($2::int[]))
                """,
                    self._workspace_id,
                    node_ids,
                )
            for row in property_link_rows:
                links.append({"source": row["node_id"], "target": row["target_id"], "type": "property-reference"})

            # 6. Co-occurrence inference
            if cooccurrence:
                if context_node_id:
                    block_rows = await conn.fetch(
                        """
                        SELECT id, parent_id FROM node
                        WHERE workspace_id = $1 AND is_page = FALSE AND active = TRUE AND page_id = $2
                    """,
                        self._workspace_id,
                        context_node_id,
                    )
                    block_ids = [r["id"] for r in block_rows]
                    parent_map = {r["id"]: r["parent_id"] for r in block_rows}

                    if block_ids:
                        co_link_rows = await conn.fetch(
                            """
                            SELECT nl.source_id AS block_id, nl.target_id
                            FROM node_link nl
                            WHERE nl.source_id = ANY($1::int[]) AND nl.target_id = ANY($2::int[])
                        """,
                            block_ids,
                            node_ids,
                        )

                        block_targets: dict = defaultdict(list)
                        for row in co_link_rows:
                            block_targets[row["block_id"]].append(row["target_id"])

                        parent_ids = list({p for p in parent_map.values() if p is not None})
                        if parent_ids:
                            parent_link_rows = await conn.fetch(
                                """
                                SELECT nl.source_id AS block_id, nl.target_id
                                FROM node_link nl
                                WHERE nl.source_id = ANY($1::int[]) AND nl.target_id = ANY($2::int[])
                            """,
                                parent_ids,
                                node_ids,
                            )
                            parent_targets: dict = defaultdict(list)
                            for row in parent_link_rows:
                                parent_targets[row["block_id"]].append(row["target_id"])

                            for block_id, parent_id in parent_map.items():
                                if parent_id in parent_targets:
                                    block_targets[block_id].extend(parent_targets[parent_id])

                        pair_counts = Counter()
                        for _block_id, targets in block_targets.items():
                            unique_targets = list(dict.fromkeys(targets))[:10]
                            if len(unique_targets) < 2:
                                continue
                            for i in range(len(unique_targets)):
                                for j in range(i + 1, len(unique_targets)):
                                    a, b = unique_targets[i], unique_targets[j]
                                    pair_counts[(a, b)] += 1

                        for (a, b), count in pair_counts.items():
                            links.append({"source": a, "target": b, "type": "cooccurrence", "weight": count})
                else:
                    sem_rows = await conn.fetch(
                        """
                        SELECT nl.source_id AS block_id, nl.target_id AS target_page_id
                        FROM node_link nl
                        JOIN node block ON nl.source_id = block.id
                        JOIN node target ON nl.target_id = target.id
                        WHERE block.workspace_id = $1
                          AND block.is_page = FALSE
                          AND block.active = TRUE
                          AND target.active = TRUE
                          AND target.is_page = TRUE
                          AND nl.target_id = ANY($2::int[])
                    """,
                        self._workspace_id,
                        node_ids,
                    )
                    block_targets: dict = defaultdict(list)
                    for row in sem_rows:
                        block_targets[row["block_id"]].append(row["target_page_id"])

                    pair_counts = Counter()
                    for _block_id, targets in block_targets.items():
                        unique_targets = list(dict.fromkeys(targets))[:10]
                        if len(unique_targets) < 2:
                            continue
                        for i in range(len(unique_targets)):
                            for j in range(i + 1, len(unique_targets)):
                                a, b = unique_targets[i], unique_targets[j]
                                pair_counts[(a, b)] += 1

                    for (a, b), count in pair_counts.items():
                        links.append({"source": a, "target": b, "type": "cooccurrence", "weight": count})

        # Deduplicate
        seen = set()
        unique_links = []
        for link in links:
            key = (link["source"], link["target"], link["type"])
            if key not in seen:
                seen.add(key)
                unique_links.append(link)

        return unique_links

    async def delete_text_links_for_workspace(self) -> int:
        """Delete all text links (property_id IS NULL) in the workspace."""
        async with acquire_connection(self._pool) as conn:
            result = await conn.execute(
                """
                DELETE FROM node_link
                WHERE workspace_id = $1
                  AND property_id IS NULL
            """,
                self._workspace_id,
            )
            return int(result.split()[-1]) if result else 0
