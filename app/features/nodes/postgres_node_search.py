"""Mixin for search and listing operations on nodes.

Extracted from postgres_node.py to keep that file focused on pure CRUD.
"""

from __future__ import annotations

from typing import Any

from app.db.connection import acquire_connection
from app.domain.entities import Node
from app.features.nodes.postgres_node_base import _PostgresNodeBase


class PostgresNodeSearchMixin(_PostgresNodeBase):
    """Search and listing operations: search, list_nodes, get_typed_with, get_all_pages, get_archived_pages."""

    _LIST_NODES_MAX_PAGE_SIZE = 5000

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
        is_user_page: bool | None = None,
        sort_by: str = "write_date",
        order: str = "desc",
    ) -> list[object]:
        """Additive multi-token search using the materialized search_text column.

        search_text is maintained by database triggers and contains:
          - the node's own plain-text content
          - recursively resolved plain-text names of outgoing link targets
          - custom labels stored on outgoing links (node_link.name)

        The query is split into tokens; ALL tokens must appear somewhere in
        search_text.  A full-text search fallback on search_vector is used for
        whole-phrase matches when the query is at least 3 characters long.

        Additional filters (class_ids, boolean flags) and sorting are applied
        in the final SELECT so PostgreSQL can limit the result set directly.
        """
        pt_n = self._plain_text_expr("n")

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
                (CASE WHEN n.open_date > NOW() - INTERVAL '7 days' THEN 1 ELSE 0 END) DESC,
                (CASE WHEN ls.last_linked_date > NOW() - INTERVAL '7 days' THEN 1 ELSE 0 END) DESC,
                COALESCE(ls.backlink_count, 0) DESC,
                n.write_date DESC NULLS LAST"""
        else:
            search_order_clause = list_order_clause

        async with acquire_connection(self._pool) as conn:
            if not query or not query.strip():
                rows = await conn.fetch(
                    f"""
                    SELECT n.* FROM node n
                    WHERE n.workspace_id = $1 AND n.active = TRUE AND n.is_deleted = FALSE
                      AND ($3::int[] IS NULL OR EXISTS (
                          WITH RECURSIVE filter_hierarchy AS (
                              SELECT id FROM node WHERE id = ANY($3::int[]) AND workspace_id = $1
                              UNION
                              SELECT ce.target_id FROM class_extend ce
                              INNER JOIN filter_hierarchy fh ON ce.source_id = fh.id
                          )
                          SELECT 1 FROM filter_hierarchy fh WHERE fh.id = ANY(n.class_ids)
                      ))
                      AND ($4::boolean IS NULL OR n.is_page = $4)
                      AND ($5::boolean IS NULL OR n.is_class = $5)
                      AND ($6::boolean IS NULL OR n.is_day = $6)
                      AND ($7::boolean IS NULL OR EXISTS (SELECT 1 FROM "user" u WHERE u.user_page_node_id = n.id) = $7)
                    {list_order_clause}
                    LIMIT $2 OFFSET $8
                """,
                    self._workspace_id,
                    limit,
                    class_filters,
                    is_page,
                    is_class,
                    is_daily,
                    is_user_page,
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

                all_text = " AND ".join(
                    f"COALESCE(n.search_text, '') ILIKE ${tp + i}" for i in range(nt)
                )
                fts_cond = "OR n.search_vector @@ plainto_tsquery('english', $3)" if len(query) >= 3 else ""

                sql = f"""
                    WITH link_stats AS (
                        SELECT
                            nl.target_id AS node_id,
                            COUNT(*) AS backlink_count,
                            MAX(nl.create_date) AS last_linked_date
                        FROM node_link nl
                        WHERE nl.workspace_id = $1
                          AND nl.is_inline_class = FALSE
                        GROUP BY nl.target_id
                    )
                    SELECT n.*,
                           ts_rank(n.search_vector, plainto_tsquery('english', $3)) AS rank
                    FROM node n
                    LEFT JOIN link_stats ls ON ls.node_id = n.id
                    WHERE n.workspace_id = $1 AND n.active = TRUE AND n.is_deleted = FALSE
                      AND ({all_text} {fts_cond})
                      AND (${fp}::int[] IS NULL OR EXISTS (
                          WITH RECURSIVE filter_hierarchy AS (
                              SELECT id FROM node WHERE id = ANY(${fp}::int[]) AND workspace_id = $1
                              UNION
                              SELECT ce.target_id FROM class_extend ce
                              INNER JOIN filter_hierarchy fh ON ce.source_id = fh.id
                          )
                          SELECT 1 FROM filter_hierarchy fh WHERE fh.id = ANY(n.class_ids)
                      ))
                      AND (${fp + 1}::boolean IS NULL OR n.is_page = ${fp + 1})
                      AND (${fp + 2}::boolean IS NULL OR n.is_class = ${fp + 2})
                      AND (${fp + 3}::boolean IS NULL OR n.is_day = ${fp + 3})
                      AND (${fp + 4}::boolean IS NULL OR EXISTS (SELECT 1 FROM "user" u WHERE u.user_page_node_id = n.id) = ${fp + 4})
                    {search_order_clause}
                    LIMIT $2 OFFSET ${fp + 5}
                """

                params = (
                    [self._workspace_id, limit, query]
                    + token_patterns
                    + [class_filters, is_page, is_class, is_daily, is_user_page, offset]
                )
                rows = await conn.fetch(sql, *params)

            return [self._row_to_node(row) for row in rows]

    async def list_nodes(
        self,
        pages_only: bool = False,
        parent_id: int | None = None,
        type_id: int | None = None,
        tag_id: int | None = None,
        class_ids: list[int] | None = None,
        root_only: bool = False,
        sort_by: str = "sequence",
        order: str = "asc",
        page: int = 1,
        page_size: int = 1000,
    ) -> tuple[list[Node], int]:
        """List nodes with server-side filtering, sorting, and pagination.

        Applies all filters directly in PostgreSQL and returns both the
        paginated node list and the total matching count.
        """
        page_size = max(1, min(page_size, self._LIST_NODES_MAX_PAGE_SIZE))
        page = max(1, page)
        offset = (page - 1) * page_size

        conditions = ["n.workspace_id = $1", "n.active = TRUE", "n.is_deleted = FALSE"]
        params: list[Any] = [self._workspace_id]
        param_idx = 2

        if pages_only:
            from app.db.schema.constants import SYSTEM_PAGE_UUIDS

            excluded_uuids = list(SYSTEM_PAGE_UUIDS.values())
            conditions.append(
                f"n.is_page = TRUE AND n.aliased_id IS NULL AND n.uuid NOT IN (SELECT unnest(${param_idx}::uuid[]))"
            )
            params.append(excluded_uuids)
            param_idx += 1

        if parent_id is not None:
            conditions.append(f"n.parent_id = ${param_idx}")
            params.append(parent_id)
            param_idx += 1
            # Match get_node_children behaviour: exclude comments.
            conditions.append("n.is_comment = FALSE")

        if type_id is not None:
            conditions.append(f"${param_idx} = ANY(n.class_ids)")
            params.append(type_id)
            param_idx += 1

        if tag_id is not None:
            conditions.append(f"${param_idx} = ANY(n.tag_ids)")
            params.append(tag_id)
            param_idx += 1

        if class_ids:
            conditions.append(f"n.class_ids && ${param_idx}::int[]")
            params.append(class_ids)
            param_idx += 1

        if root_only:
            conditions.append("n.parent_id IS NULL")

        where_clause = " AND ".join(conditions)

        order_dir = "DESC" if order == "desc" else "ASC"
        pt_n = self._plain_text_expr("n")
        if sort_by == "name":
            order_clause = f"ORDER BY LOWER({pt_n}) {order_dir} NULLS LAST"
        elif sort_by == "create_date":
            order_clause = f"ORDER BY n.create_date {order_dir} NULLS LAST"
        elif sort_by == "write_date":
            order_clause = f"ORDER BY n.write_date {order_dir} NULLS LAST"
        else:
            order_clause = f"ORDER BY COALESCE(n.sequence, 0) {order_dir} NULLS LAST"

        async with acquire_connection(self._pool) as conn:
            count_row = await conn.fetchrow(
                f"SELECT COUNT(*) AS total FROM node n WHERE {where_clause}",
                *params,
            )
            total = count_row["total"] if count_row else 0

            rows = await conn.fetch(
                f"""
                SELECT n.* FROM node n
                WHERE {where_clause}
                {order_clause}
                LIMIT ${param_idx} OFFSET ${param_idx + 1}
                """,
                *params,
                page_size,
                offset,
            )
            return [self._row_to_node(row) for row in rows], total

    async def get_typed_with(
        self, type_node_id: int, limit: int = 1000, offset: int = 0
    ) -> list[object]:
        """Get nodes with a specific type, paginated."""
        async with acquire_connection(self._pool) as conn:
            rows = await conn.fetch(
                """
                SELECT n.* FROM node n
                WHERE $1 = ANY(n.class_ids)
                  AND n.workspace_id = $2 AND n.active = TRUE AND n.is_deleted = FALSE
                LIMIT $3 OFFSET $4
            """,
                type_node_id,
                self._workspace_id,
                limit,
                offset,
            )
            return [self._row_to_node(row) for row in rows]

    async def get_task_nodes(
        self, limit: int = 1000, offset: int = 0
    ) -> list[object]:
        """Get active task nodes using the is_task index, paginated."""
        async with acquire_connection(self._pool) as conn:
            rows = await conn.fetch(
                """
                SELECT n.* FROM node n
                WHERE n.is_task = TRUE
                  AND n.workspace_id = $1 AND n.active = TRUE AND n.is_deleted = FALSE
                LIMIT $2 OFFSET $3
            """,
                self._workspace_id,
                limit,
                offset,
            )
            return [self._row_to_node(row) for row in rows]

    _MAX_PAGES_LIMIT = 5000

    async def get_all_pages(self, limit: int = 1000, offset: int = 0) -> list[object]:
        """Get active nodes tagged as 'page', bounded and paginated."""
        from app.db.schema.constants import SYSTEM_PAGE_UUIDS

        if limit < 1:
            limit = 1
        if offset < 0:
            offset = 0
        limit = min(limit, self._MAX_PAGES_LIMIT)

        async with acquire_connection(self._pool) as conn:
            excluded_uuids = list(SYSTEM_PAGE_UUIDS.values())
            rows = await conn.fetch(
                """
                SELECT * FROM node
                WHERE is_page = true AND active = true AND is_deleted = false AND workspace_id = $1
                  AND uuid NOT IN (SELECT unnest($2::uuid[]))
                  AND aliased_id IS NULL
                ORDER BY write_date DESC NULLS LAST
                LIMIT $3 OFFSET $4
                """,
                self._workspace_id,
                excluded_uuids,
                limit,
                offset,
            )
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

    async def get_recent_pages(self, limit: int = 10) -> list[object]:
        """Get recently opened pages ordered by open_date DESC."""
        async with acquire_connection(self._pool) as conn:
            rows = await conn.fetch(
                """
                SELECT * FROM node
                WHERE is_page = true AND active = true
                      AND (is_deleted = false OR is_deleted IS NULL)
                      AND open_date IS NOT NULL
                      AND workspace_id = $1
                ORDER BY open_date DESC
                LIMIT $2
            """,
                self._workspace_id,
                limit,
            )
            return [self._row_to_node(row) for row in rows]

    async def get_random_pages(self, limit: int = 5) -> list[object]:
        """Get random non-deleted, non-system pages."""
        async with acquire_connection(self._pool) as conn:
            rows = await conn.fetch(
                """
                SELECT * FROM node
                WHERE is_page = true AND active = true
                      AND (is_deleted = false OR is_deleted IS NULL)
                      AND is_class = false AND is_day = false
                      AND is_month = false AND is_year = false
                      AND workspace_id = $1
                ORDER BY RANDOM()
                LIMIT $2
            """,
                self._workspace_id,
                limit,
            )
            return [self._row_to_node(row) for row in rows]

    async def get_recently_created_pages(self, limit: int = 5) -> list[object]:
        """Get recently created pages ordered by create_date DESC."""
        async with acquire_connection(self._pool) as conn:
            rows = await conn.fetch(
                """
                SELECT * FROM node
                WHERE is_page = true AND active = true
                      AND (is_deleted = false OR is_deleted IS NULL)
                      AND workspace_id = $1
                ORDER BY create_date DESC
                LIMIT $2
            """,
                self._workspace_id,
                limit,
            )
            return [self._row_to_node(row) for row in rows]

    async def get_node_suggestions(
        self, class_filter_ids: list[int] | None, limit: int
    ) -> tuple[list[object], list[object]]:
        """Return suggested pages: recently created and recently linked.

        The persistence logic mirrors the legacy router query in
        ``crud.py::get_node_suggestions``.
        """
        class_filter_clause = ""
        if class_filter_ids:
            class_filter_clause = " AND n.class_ids && $3::int[]"

        async with acquire_connection(self._pool) as conn:
            params_recent: list = [self._workspace_id, limit]
            if class_filter_ids:
                params_recent.append(class_filter_ids)

            recent_rows = await conn.fetch(
                f"""
                SELECT n.*
                FROM node n
                WHERE n.is_page = true AND n.active = true
                      AND (n.is_deleted = false OR n.is_deleted IS NULL)
                      AND n.workspace_id = $1
                      AND n.create_date > NOW() - INTERVAL '15 minutes'
                      {class_filter_clause}
                ORDER BY n.create_date DESC
                LIMIT $2
            """,
                *params_recent,
            )
            recent_nodes = [self._row_to_node(row) for row in recent_rows]
            recent_ids = {row["id"] for row in recent_rows}

            remaining = limit - len(recent_rows)
            linked_nodes: list[object] = []
            if remaining > 0:
                exclude_clause = ""
                params_linked: list = [self._workspace_id, remaining]
                param_idx = 3

                if recent_ids:
                    exclude_clause = f" AND n.id != ALL(${param_idx}::int[])"
                    params_linked.append(list(recent_ids))
                    param_idx += 1

                if class_filter_ids:
                    class_filter_clause_linked = f" AND n.class_ids && ${param_idx}::int[]"
                    params_linked.append(class_filter_ids)
                else:
                    class_filter_clause_linked = ""

                linked_rows = await conn.fetch(
                    f"""
                    SELECT n.*
                    FROM node n
                    INNER JOIN (
                        SELECT target_id, MAX(create_date) AS last_linked
                        FROM node_link
                        WHERE workspace_id = $1
                        GROUP BY target_id
                    ) nl ON nl.target_id = n.id
                    WHERE n.is_page = true AND n.active = true
                          AND (n.is_deleted = false OR n.is_deleted IS NULL)
                          AND n.workspace_id = $1
                          {exclude_clause}
                          {class_filter_clause_linked}
                    ORDER BY nl.last_linked DESC
                    LIMIT $2
                """,
                    *params_linked,
                )
                linked_nodes = [self._row_to_node(row) for row in linked_rows]

        return recent_nodes, linked_nodes
