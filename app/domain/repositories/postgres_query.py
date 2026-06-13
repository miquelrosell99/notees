"""PostgreSQL implementation of QueryRepository.

Executes queries using QueryASTToSQL for SQL generation.
Handles parameter substitution, SQL execution, and result formatting.
"""

from __future__ import annotations

import time
from datetime import date, datetime, timedelta
from typing import Any

from ...db.connection import acquire_connection
from ...logging_config import get_logger
from ..entities.query_ast import ConditionType, GroupNode, NotNode, PropertyCondition, PropertyType, QueryAST
from ..services.query_ast_optimizer import compute_ast_complexity, optimize_ast
from ..services.query_ast_sql import QueryASTToSQL
from ..services.query_sql_cache import get_sql_cache
from .base import BasePostgresRepository
from .interfaces import QueryRepository

logger = get_logger(__name__)


class PostgresQueryRepository(BasePostgresRepository, QueryRepository):
    """Executes generated queries and returns results."""

    def __init__(self, pool, workspace_id: int, user_id: str | None = None):
        super().__init__(pool, workspace_id, int(user_id) if user_id else None)
        self._sql_cache = get_sql_cache()

    def _substitute_params(self, query_ast: QueryAST, runtime_params: dict[str, Any]) -> QueryAST:
        """Substitute runtime parameters in QueryAST."""
        import copy

        logger.debug("[_substitute_params] runtime_params keys=%s", list(runtime_params.keys()) if runtime_params else None)
        query_ast = copy.deepcopy(query_ast)

        if hasattr(query_ast.scope, "excluded_page_uuids") and query_ast.scope.excluded_page_uuids:
            query_ast.scope.excluded_page_uuids = [
                self._resolve_placeholder(uuid, runtime_params) for uuid in query_ast.scope.excluded_page_uuids
            ]

        self._substitute_in_group(query_ast.root_group, runtime_params)
        return query_ast

    def _substitute_in_group(self, group, runtime_params: dict[str, Any]):
        """Recursively substitute parameters in a group."""
        from ..entities.query_ast import (
            ClassCondition,
            ContentCondition,
            ExtendsCondition,
            GroupNode,
            NotNode,
            ParentCondition,
            PropertyCondition,
            ReferenceCondition,
            ReferencePathCondition,
        )

        logger.debug(f"[_substitute_in_group] Processing group with {len(group.children)} children")

        for child in group.children:
            logger.debug(f"[_substitute_in_group] Child type: {type(child).__name__}")
            if isinstance(child, GroupNode):
                self._substitute_in_group(child, runtime_params)
            elif isinstance(child, NotNode):
                if isinstance(child.child, GroupNode):
                    self._substitute_in_group(child.child, runtime_params)
                elif isinstance(child.child, ClassCondition):
                    child.child.class_uuid = self._resolve_placeholder(child.child.class_uuid, runtime_params)
                elif isinstance(child.child, ExtendsCondition):
                    child.child.extends_class_uuid = self._resolve_placeholder(
                        child.child.extends_class_uuid, runtime_params
                    )
                elif isinstance(child.child, ReferenceCondition):
                    child.child.target_uuid = self._resolve_placeholder(child.child.target_uuid, runtime_params)
                elif isinstance(child.child, ReferencePathCondition):
                    if child.child.target_uuids:
                        child.child.target_uuids = [
                            self._resolve_placeholder(u, runtime_params) for u in child.child.target_uuids
                        ]
                    if child.child.nested_group:
                        self._substitute_in_group(child.child.nested_group, runtime_params)
                elif isinstance(child.child, (ContentCondition, PropertyCondition)):
                    child.child.value = self._resolve_placeholder(child.child.value, runtime_params)
                elif isinstance(child.child, ParentCondition):
                    if child.child.parent_uuid:
                        logger.debug("[_substitute_in_group] NOT>ParentCondition parent_uuid before: %s", child.child.parent_uuid)
                        child.child.parent_uuid = self._resolve_placeholder(child.child.parent_uuid, runtime_params)
                        logger.debug("[_substitute_in_group] NOT>ParentCondition parent_uuid after: %s", child.child.parent_uuid)
                    if child.child.nested_group:
                        self._substitute_in_group(child.child.nested_group, runtime_params)
            elif isinstance(child, ClassCondition):
                child.class_uuid = self._resolve_placeholder(child.class_uuid, runtime_params)
            elif isinstance(child, ExtendsCondition):
                child.extends_class_uuid = self._resolve_placeholder(child.extends_class_uuid, runtime_params)
            elif isinstance(child, ReferenceCondition):
                child.target_uuid = self._resolve_placeholder(child.target_uuid, runtime_params)
            elif isinstance(child, ReferencePathCondition):
                if child.target_uuids:
                    child.target_uuids = [self._resolve_placeholder(u, runtime_params) for u in child.target_uuids]
                if child.nested_group:
                    self._substitute_in_group(child.nested_group, runtime_params)
            elif isinstance(child, (PropertyCondition, ContentCondition)):
                child.value = self._resolve_placeholder(child.value, runtime_params)
            elif isinstance(child, ParentCondition):
                logger.debug("[_substitute_in_group] ParentCondition found, parent_uuid=%s", child.parent_uuid)
                if child.parent_uuid:
                    logger.debug("[_substitute_in_group] ParentCondition parent_uuid before: %s", child.parent_uuid)
                    child.parent_uuid = self._resolve_placeholder(child.parent_uuid, runtime_params)
                    logger.debug("[_substitute_in_group] ParentCondition parent_uuid after: %s", child.parent_uuid)
                if child.nested_group:
                    self._substitute_in_group(child.nested_group, runtime_params)

    async def _resolve_property_names(self, query_ast: QueryAST) -> None:
        """Resolve bare property names to property UUIDs and types.

        Property conditions produced by the text query language often only have
        a property_name. This method looks up matching properties in the
        workspace and populates property_uuid and property_type accordingly.
        """
        builtin_columns = {
            "uuid",
            "name",
            "id",
            "parent_id",
            "is_page",
            "is_favorite",
            "page_uuid",
            "create_date",
            "write_date",
            "open_date",
        }
        names_to_resolve: set[str] = set()

        def collect(group: GroupNode) -> None:
            for child in group.children:
                if isinstance(child, GroupNode):
                    collect(child)
                elif isinstance(child, NotNode):
                    if isinstance(child.child, GroupNode):
                        collect(child.child)
                    elif isinstance(child.child, PropertyCondition):
                        maybe_add(child.child)
                elif isinstance(child, PropertyCondition):
                    maybe_add(child)

        def maybe_add(condition: PropertyCondition) -> None:
            if (
                condition.condition_type == ConditionType.PROPERTY
                and condition.property_name not in builtin_columns
                and not condition.property_uuid
            ):
                names_to_resolve.add(condition.property_name)

        collect(query_ast.root_group)
        if not names_to_resolve:
            return

        async with acquire_connection(self._pool) as conn:
            rows = await conn.fetch(
                "SELECT name, uuid, type FROM property WHERE workspace_id = $1 AND name = ANY($2)",
                self._workspace_id,
                list(names_to_resolve),
            )

        mapping = {row["name"]: {"uuid": str(row["uuid"]), "type": row["type"]} for row in rows}

        def apply(group: GroupNode) -> None:
            for child in group.children:
                if isinstance(child, GroupNode):
                    apply(child)
                elif isinstance(child, NotNode):
                    if isinstance(child.child, GroupNode):
                        apply(child.child)
                    elif isinstance(child.child, PropertyCondition):
                        apply_cond(child.child)
                elif isinstance(child, PropertyCondition):
                    apply_cond(child)

        def apply_cond(condition: PropertyCondition) -> None:
            info = mapping.get(condition.property_name)
            if not info:
                return
            condition.property_uuid = info["uuid"]
            condition.property_type = PropertyType(info["type"])

        apply(query_ast.root_group)

    def _resolve_placeholder(self, value: Any, runtime_params: dict[str, Any]) -> Any:
        """Resolve a single placeholder value to a typed runtime value.

        String placeholders such as {current_node_uuid} are resolved from the
        supplied runtime_params. Date placeholders ({today}, {this_week}, ...)
        are resolved server-side to datetime.date values so they can be sent to
        PostgreSQL as real date parameters.
        """
        if not isinstance(value, str) or not value.startswith("{"):
            return value

        if value == "{current_node_name}":
            name_value = runtime_params.get("current_node_name", "")
            if not name_value:
                logger.warning("Placeholder {current_node_name} used but no runtime value provided")
            return name_value
        elif value == "{current_node_uuid}":
            uuid_value = runtime_params.get("current_node_uuid", "")
            if not uuid_value:
                logger.warning("Placeholder {current_node_uuid} used but no runtime value provided")
            return uuid_value
        elif value == "{current_node_id}":
            id_value = runtime_params.get("current_node_id")
            if id_value is None:
                logger.warning("Placeholder {current_node_id} used but no runtime value provided")
                return None
            return int(id_value)
        elif value == "{current_user_id}":
            user_value = self._user_id or runtime_params.get("current_user_id")
            if user_value is None:
                logger.warning("Placeholder {current_user_id} used but no runtime value provided")
                return None
            return int(user_value)
        elif value == "{today}":
            return date.today()
        elif value == "{this_week}":
            today = date.today()
            return today - timedelta(days=today.weekday())
        elif value == "{this_month}":
            today = date.today()
            return today.replace(day=1)
        elif value == "{this_year}":
            today = date.today()
            return date(today.year, 1, 1)

        return value

    async def execute_query(
        self,
        query: dict[str, Any] | QueryAST,
        runtime_params: dict[str, Any] | None = None,
        limit: int | None = None,
        offset: int | None = None,
        order_by: str | None = None,
        enrich: dict[str, bool] | None = None,
    ) -> dict[str, Any]:
        """Execute a query and return results with optional pagination metadata."""
        t_start = time.monotonic()

        # Defense-in-depth: clamp pagination parameters even though routers
        # validate them via Pydantic.
        if limit is not None:
            limit = max(1, min(int(limit), 1000))
        if offset is not None:
            offset = max(0, int(offset))

        query_ast = QueryAST.from_dict(query) if isinstance(query, dict) else query

        await self._resolve_property_names(query_ast)
        query_ast = self._substitute_params(query_ast, runtime_params or {})

        ast_metrics = compute_ast_complexity(query_ast)
        query_ast = optimize_ast(query_ast)
        ast_metrics_after = compute_ast_complexity(query_ast)

        current_node_uuid = runtime_params.get("current_node_uuid") if runtime_params else None
        sql, params, cache_hit = self._generate_sql_cached(query_ast, current_node_uuid)

        params_list = []
        for param_name, value in params.items():
            params_list.append(value)
            placeholder = f"%({param_name})s"
            positional = f"${len(params_list)}"
            sql = sql.replace(placeholder, positional)

        base_sql = sql
        if limit:
            sql += f" LIMIT ${len(params_list) + 1}"
            params_list.append(limit)
        if offset:
            sql += f" OFFSET ${len(params_list) + 1}"
            params_list.append(offset)

        logger.debug(f"Executing query SQL: {sql}")
        logger.debug(f"Query params: {params_list}")

        t_sql_start = time.monotonic()

        async with acquire_connection(self._pool) as conn:
            rows = await conn.fetch(sql, *params_list)

            total_count = None
            if not query_ast.aggregation and (limit is not None or offset is not None):
                count_sql = f"SELECT COUNT(*) as count FROM ({base_sql}) subq"
                count_params = list(params.values())
                count_row = await conn.fetchrow(count_sql, *count_params)
                total_count = count_row["count"] if count_row else 0

        t_sql_end = time.monotonic()

        if query_ast.aggregation:
            groups: list[dict[str, Any]] = []
            for row in rows:
                group_dict = dict(row)
                if isinstance(group_dict.get("group_key"), date):
                    group_dict["group_key"] = group_dict["group_key"].isoformat()
                groups.append(group_dict)
            results: list[dict[str, Any]] = groups
        else:
            results = self._rows_to_dicts(rows)

        t_end = time.monotonic()

        metrics = {
            "ast_nodes_before": ast_metrics["total_nodes"],
            "ast_nodes_after": ast_metrics_after["total_nodes"],
            "conditions_before": ast_metrics["condition_count"],
            "conditions_after": ast_metrics_after["condition_count"],
            "max_depth": ast_metrics_after["max_depth"],
            "has_recursive_cte": ast_metrics_after["has_recursive_cte"],
            "has_path_queries": ast_metrics_after["has_path_queries"],
            "has_property_joins": ast_metrics_after["has_property_joins"],
            "has_content_search": ast_metrics_after["has_content_search"],
            "sql_cache_hit": cache_hit,
            "rows_returned": len(results),
            "total_count": total_count,
            "sql_time_ms": round((t_sql_end - t_sql_start) * 1000, 2),
            "total_time_ms": round((t_end - t_start) * 1000, 2),
        }

        logger.info(
            f"[QueryMetrics] rows={len(results)} sql_ms={metrics['sql_time_ms']} "
            f"total_ms={metrics['total_time_ms']} cache_hit={cache_hit} "
            f"conditions={ast_metrics_after['condition_count']} "
            f"depth={ast_metrics_after['max_depth']}"
        )

        response: dict[str, Any] = {
            "nodes": results,
            "metrics": metrics,
        }
        if query_ast.aggregation:
            response = {"groups": results, "metrics": metrics}
        elif total_count is not None:
            response["total_count"] = total_count

        return response

    async def execute_query_legacy(
        self,
        query: dict[str, Any] | QueryAST,
        runtime_params: dict[str, Any] | None = None,
        limit: int | None = None,
        offset: int | None = None,
        order_by: str | None = None,
    ) -> list[dict[str, Any]]:
        """Legacy execute_query that returns a flat list of node dicts."""
        result = await self.execute_query(
            query=query,
            runtime_params=runtime_params,
            limit=limit,
            offset=offset,
            order_by=order_by,
        )
        return result["nodes"]

    def _generate_sql_cached(
        self,
        query_ast: QueryAST,
        current_node_uuid: str | None,
    ) -> tuple:
        """Generate SQL, using cache for repeated AST structures."""
        generator = QueryASTToSQL(self._workspace_id, current_node_uuid)
        if query_ast.aggregation:
            sql, params = generator.generate_aggregate(query_ast)
        else:
            sql, params = generator.generate(query_ast)
        return sql, params, False

    def _rows_to_dicts(self, rows) -> list[dict[str, Any]]:
        """Convert asyncpg Row objects to plain dicts."""
        results = []
        for row in rows:
            node_dict = dict(row)
            if "uuid" in node_dict:
                node_dict["uuid"] = str(node_dict["uuid"])
            if "page_uuid" in node_dict and node_dict["page_uuid"]:
                node_dict["page_uuid"] = str(node_dict["page_uuid"])
            for key in ("create_date", "write_date", "open_date"):
                if key in node_dict and node_dict[key] and isinstance(node_dict[key], datetime):
                    node_dict[key] = node_dict[key].isoformat()
            results.append(node_dict)
        return results

    async def count_query_results(
        self,
        query: dict[str, Any] | QueryAST,
        runtime_params: dict[str, Any] | None = None,
    ) -> int:
        """Count results for a query without fetching all data."""
        query_ast = QueryAST.from_dict(query) if isinstance(query, dict) else query

        await self._resolve_property_names(query_ast)
        query_ast = self._substitute_params(query_ast, runtime_params or {})
        query_ast = optimize_ast(query_ast)

        current_node_uuid = runtime_params.get("current_node_uuid") if runtime_params else None
        generator = QueryASTToSQL(self._workspace_id, current_node_uuid)
        sql, params_dict = generator.generate(query_ast)

        params = []
        for param_name, value in params_dict.items():
            params.append(value)
            placeholder = f"%({param_name})s"
            positional = f"${len(params)}"
            sql = sql.replace(placeholder, positional)

        count_sql = f"SELECT COUNT(*) as count FROM ({sql}) subq"

        async with acquire_connection(self._pool) as conn:
            row = await conn.fetchrow(count_sql, *params)

        return row["count"] if row else 0
