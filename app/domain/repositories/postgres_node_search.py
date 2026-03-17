"""Mixin for search and listing operations on nodes.

Extracted from postgres_node.py to keep that file focused on pure CRUD.
"""
from __future__ import annotations

from typing import Optional, List

from ...db.connection import acquire_connection
from .postgres_node_base import _PostgresNodeBase


class PostgresNodeSearchMixin(_PostgresNodeBase):
    """Search and listing operations: search, get_typed_with, get_all_pages, get_archived_pages."""

    async def search(self, query: str, limit: int = 50) -> List[object]:
        """Search nodes by name using full-text search.

        Extracts plain text from AST-formatted names for reliable ILIKE matching.
        Also resolves embedded node_link labels and target node names so that nodes
        containing inline links are findable by the linked node's display text.
        """
        # Simplified own-name text used for result ranking (prefix/exact ordering).
        name_text = """(CASE
            WHEN n.name IS NOT NULL AND n.name LIKE '[%' THEN
                COALESCE((SELECT string_agg(t #>> '{}', '') FROM jsonb_path_query(n.name::jsonb, '$.**.text') AS t), '')
            ELSE COALESCE(n.name, '')
        END)"""

        # Extended text for WHERE filtering: own text leaves + node_link labels +
        # resolved target node plain-text names (via the node_link join table).
        full_text = """(CASE
            WHEN n.name IS NOT NULL AND n.name LIKE '[%' THEN
                COALESCE(
                    (SELECT string_agg(val, ' ')
                     FROM (
                         -- Plain text leaves from own AST
                         SELECT t #>> '{}' AS val
                         FROM jsonb_path_query(n.name::jsonb, '$.**.text') AS t
                         UNION ALL
                         -- Custom labels on embedded node_link elements
                         SELECT lbl #>> '{}' AS val
                         FROM jsonb_path_query(n.name::jsonb, '$.** ? (@.type == "node_link").label') AS lbl
                         WHERE lbl #>> '{}' IS NOT NULL
                         UNION ALL
                         -- Target node plain-text names for embedded links
                         SELECT (CASE WHEN tn.name LIKE '[%' THEN
                             COALESCE((SELECT string_agg(tv #>> '{}', '') FROM jsonb_path_query(tn.name::jsonb, '$.**.text') AS tv), '')
                         ELSE COALESCE(tn.name, '') END) AS val
                         FROM jsonb_path_query(n.name::jsonb, '$.** ? (@.type == "node_link").link_id') AS link_uuid_j
                         JOIN node_link nl ON nl.uuid = (link_uuid_j #>> '{}')::uuid
                             AND nl.workspace_id = n.workspace_id
                         JOIN node tn ON tn.id = nl.target_id
                             AND tn.active = TRUE AND tn.is_deleted = FALSE
                     ) combined
                     WHERE val IS NOT NULL AND val != ''),
                    ''
                )
            ELSE COALESCE(n.name, '')
        END)"""

        async with acquire_connection(self._pool) as conn:
            if len(query) >= 3:
                rows = await conn.fetch(f"""
                    SELECT n.*, ts_rank(n.search_vector, plainto_tsquery('english', $1)) AS rank
                    FROM node n
                    WHERE n.workspace_id = $2 AND n.active = TRUE AND n.is_deleted = FALSE
                    AND (n.search_vector @@ plainto_tsquery('english', $1) OR {full_text} ILIKE $3)
                    ORDER BY
                        (LOWER({name_text}) = LOWER($1)) DESC,
                        (LOWER({name_text}) LIKE LOWER($1) || '%') DESC,
                        rank DESC,
                        n.write_date DESC
                    LIMIT $4
                """, query, self._workspace_id, f'%{query}%', limit)
            else:
                rows = await conn.fetch(f"""
                    SELECT n.* FROM node n
                    WHERE {full_text} ILIKE $1
                    AND n.workspace_id = $2 AND n.active = TRUE AND n.is_deleted = FALSE
                    ORDER BY
                        (LOWER({name_text}) = LOWER($4)) DESC,
                        (LOWER({name_text}) LIKE LOWER($4) || '%') DESC,
                        n.write_date DESC
                    LIMIT $3
                """, f'%{query}%', self._workspace_id, limit, query)
            return [self._row_to_node(row) for row in rows]

    async def get_typed_with(self, type_node_id: int) -> List[object]:
        """Get all nodes with a specific type."""
        async with acquire_connection(self._pool) as conn:
            rows = await conn.fetch("""
                SELECT n.* FROM node n
                WHERE $1 = ANY(n.class_ids)
                  AND n.workspace_id = $2 AND n.active = TRUE AND n.is_deleted = FALSE
            """, type_node_id, self._workspace_id)
            return [self._row_to_node(row) for row in rows]

    async def get_all_pages(self, limit: Optional[int] = None, offset: int = 0) -> List[object]:
        """Get all active nodes tagged as 'page'."""
        from ...db.schema.constants import SYSTEM_PAGE_UUIDS

        async with acquire_connection(self._pool) as conn:
            query = """
                SELECT * FROM node
                WHERE is_page = true AND active = true AND is_deleted = false AND workspace_id = $1
                  AND uuid NOT IN (SELECT unnest($2::uuid[]))
                ORDER BY write_date DESC NULLS LAST
            """
            excluded_uuids = list(SYSTEM_PAGE_UUIDS.values())
            params: list = [self._workspace_id, excluded_uuids]

            if limit is not None:
                query += " LIMIT $3 OFFSET $4"
                params.extend([limit, offset])

            rows = await conn.fetch(query, *params)
            return [self._row_to_node(row) for row in rows]

    async def get_archived_pages(self) -> List[object]:
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
