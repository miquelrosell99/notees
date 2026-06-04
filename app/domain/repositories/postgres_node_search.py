"""Mixin for search and listing operations on nodes.

Extracted from postgres_node.py to keep that file focused on pure CRUD.
"""

from __future__ import annotations

from ...db.connection import acquire_connection
from .postgres_node_base import _PostgresNodeBase


class PostgresNodeSearchMixin(_PostgresNodeBase):
    """Search and listing operations: search, get_typed_with, get_all_pages, get_archived_pages."""

    @staticmethod
    def _plain_text_expr(alias: str) -> str:
        """SQL expression that extracts plain text from an AST-format name column."""
        return f"""(CASE
            WHEN {alias}.name IS NOT NULL AND {alias}.name LIKE '[%' THEN
                COALESCE((SELECT string_agg(t #>> '{{}}', '') FROM jsonb_path_query({alias}.name::jsonb, '$.**.text') AS t), '')
            ELSE COALESCE({alias}.name, '')
        END)"""

    async def search(
        self,
        query: str,
        limit: int = 50,
        offset: int = 0,
        class_filters: list[int] | None = None,
        is_page: bool | None = None,
        is_class: bool | None = None,
        is_daily: bool | None = None,
        sort_by: str = "write_date",
        order: str = "desc",
    ) -> list[object]:
        """Additive multi-token search across own text, link targets, and labels.

        Splits the query into tokens.  For each candidate node, a combined
        searchable text is built from:
          - the node's own plain-text content
          - plain-text names of all outgoing link targets (via node_link)
          - custom labels stored on outgoing links (node_link.name)

        ALL tokens must appear somewhere in that combined text.

        To keep it fast the search is two-phase:
          1. *Candidates* — nodes matching ANY single token in any source
             (own name, link target name, or link label).  Uses FTS index
             and node_link indexes.
          2. *Full-text filter* — for candidates only, build the combined
             text via an indexed LATERAL join and verify ALL tokens match.

        Additional filters (class_ids, boolean flags) and sorting are applied
        in the final SELECT so PostgreSQL can limit the result set directly.
        """
        pt_n = self._plain_text_expr("n")
        pt_tn = self._plain_text_expr("tn")

        order_dir = "DESC" if order == "desc" else "ASC"
        if sort_by == "name":
            list_order_clause = f"ORDER BY LOWER({pt_n}) {order_dir}"
        elif sort_by == "create_date":
            list_order_clause = f"ORDER BY n.create_date {order_dir} NULLS LAST"
        else:
            list_order_clause = f"ORDER BY n.write_date {order_dir} NULLS LAST"

        # For text searches, default to relevance when sort_by is write_date (the default)
        if query and query.strip() and sort_by == "write_date":
            search_order_clause = f"""ORDER BY
                n.is_page DESC,
                (LOWER({pt_n}) = LOWER($3)) DESC,
                (LOWER({pt_n}) LIKE LOWER($3) || '%') DESC,
                rank DESC,
                n.write_date DESC NULLS LAST"""
        else:
            search_order_clause = list_order_clause

        async with acquire_connection(self._pool) as conn:
            if not query or not query.strip():
                rows = await conn.fetch(
                    f"""
                    SELECT n.* FROM node n
                    WHERE n.workspace_id = $1 AND n.active = TRUE AND n.is_deleted = FALSE
                      AND ($3::int[] IS NULL OR n.class_ids && $3::int[])
                      AND ($4::boolean IS NULL OR n.is_page = $4)
                      AND ($5::boolean IS NULL OR n.is_class = $5)
                      AND ($6::boolean IS NULL OR n.is_day = $6)
                    {list_order_clause}
                    LIMIT $2 OFFSET $7
                """,
                    self._workspace_id,
                    limit,
                    class_filters,
                    is_page,
                    is_class,
                    is_daily,
                    offset,
                )
            else:
                tokens = query.split()
                token_patterns = [f"%{t}%" for t in tokens]

                # Params: $1=workspace_id  $2=limit  $3=full query  $4‥=token ILIKE patterns
                tp = 4  # index of first token param
                nt = len(tokens)

                # Filter params come after token params
                fp = tp + nt

                any_own = " OR ".join(f"{pt_n}  ILIKE ${tp + i}" for i in range(nt))
                any_tgt = " OR ".join(f"{pt_tn} ILIKE ${tp + i}" for i in range(nt))
                any_label = " OR ".join(f"nl.name ILIKE ${tp + i}" for i in range(nt))
                all_full = " AND ".join(f"nft.full_text ILIKE ${tp + i}" for i in range(nt))

                fts_cond = "OR n.search_vector @@ plainto_tsquery('english', $3)" if len(query) >= 3 else ""

                sql = f"""
                    WITH candidates AS (
                        -- Nodes whose own text matches ANY token (+ FTS)
                        SELECT n.id FROM node n
                        WHERE n.workspace_id = $1 AND n.active = TRUE AND n.is_deleted = FALSE
                          AND ({any_own} {fts_cond})
                        UNION
                        -- Source nodes of links whose TARGET name matches ANY token
                        SELECT nl.source_id AS id FROM node_link nl
                        JOIN node tn ON tn.id = nl.target_id
                            AND tn.active = TRUE AND tn.is_deleted = FALSE
                        WHERE nl.workspace_id = $1 AND ({any_tgt})
                        UNION
                        -- Source nodes of links whose custom label matches ANY token
                        SELECT nl.source_id AS id FROM node_link nl
                        WHERE nl.workspace_id = $1 AND nl.name IS NOT NULL
                          AND ({any_label})
                    ),
                    node_full_text AS (
                        SELECT
                            c.id,
                            {pt_n}
                            || ' ' || COALESCE(la.combined, '')
                            AS full_text
                        FROM candidates c
                        JOIN node n ON n.id = c.id
                            AND n.active = TRUE AND n.is_deleted = FALSE
                        LEFT JOIN LATERAL (
                            SELECT string_agg(
                                COALESCE(nl.name, '') || ' ' || {pt_tn},
                                ' '
                            ) AS combined
                            FROM node_link nl
                            JOIN node tn ON tn.id = nl.target_id
                                AND tn.active = TRUE AND tn.is_deleted = FALSE
                            WHERE nl.source_id = c.id AND nl.workspace_id = $1
                        ) la ON TRUE
                    )
                    SELECT n.*,
                           ts_rank(n.search_vector, plainto_tsquery('english', $3)) AS rank
                    FROM node n
                    JOIN node_full_text nft ON nft.id = n.id
                    WHERE {all_full}
                      AND (${fp}::int[] IS NULL OR n.class_ids && ${fp})
                      AND (${fp + 1}::boolean IS NULL OR n.is_page = ${fp + 1})
                      AND (${fp + 2}::boolean IS NULL OR n.is_class = ${fp + 2})
                      AND (${fp + 3}::boolean IS NULL OR n.is_day = ${fp + 3})
                    {search_order_clause}
                    LIMIT $2 OFFSET ${fp + 4}
                """

                params = (
                    [self._workspace_id, limit, query]
                    + token_patterns
                    + [class_filters, is_page, is_class, is_daily, offset]
                )
                rows = await conn.fetch(sql, *params)

            return [self._row_to_node(row) for row in rows]

    async def get_typed_with(self, type_node_id: int) -> list[object]:
        """Get all nodes with a specific type."""
        async with acquire_connection(self._pool) as conn:
            rows = await conn.fetch(
                """
                SELECT n.* FROM node n
                WHERE $1 = ANY(n.class_ids)
                  AND n.workspace_id = $2 AND n.active = TRUE AND n.is_deleted = FALSE
            """,
                type_node_id,
                self._workspace_id,
            )
            return [self._row_to_node(row) for row in rows]

    async def get_all_pages(self, limit: int | None = None, offset: int = 0) -> list[object]:
        """Get all active nodes tagged as 'page'."""
        from ...db.schema.constants import SYSTEM_PAGE_UUIDS

        async with acquire_connection(self._pool) as conn:
            query = """
                SELECT * FROM node
                WHERE is_page = true AND active = true AND is_deleted = false AND workspace_id = $1
                  AND uuid NOT IN (SELECT unnest($2::uuid[]))
                  AND aliased_id IS NULL
                ORDER BY write_date DESC NULLS LAST
            """
            excluded_uuids = list(SYSTEM_PAGE_UUIDS.values())
            params: list = [self._workspace_id, excluded_uuids]

            if limit is not None:
                query += " LIMIT $3 OFFSET $4"
                params.extend([limit, offset])

            rows = await conn.fetch(query, *params)
            return [self._row_to_node(row) for row in rows]

    async def get_archived_pages(self) -> list[object]:
        """Get all archived nodes tagged as 'page'."""
        async with acquire_connection(self._pool) as conn:
            rows = await conn.fetch(
                """
                SELECT * FROM node
                WHERE is_page = true AND active = false
                      AND (is_deleted = false OR is_deleted IS NULL)
                      AND workspace_id = $1
                ORDER BY write_date DESC NULLS LAST
            """,
                self._workspace_id,
            )
            return [self._row_to_node(row) for row in rows]
