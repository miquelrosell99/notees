"""PostgreSQL implementation of QueryRepository.

Executes queries using QueryASTToSQL for SQL generation.
Handles parameter substitution, SQL execution, and result formatting.
"""
from __future__ import annotations

import re
import time
from datetime import datetime
from typing import Optional, List, Dict, Any, Union

from ..entities.query_ast import QueryAST
from ..services.query_ast_sql import QueryASTToSQL
from ..services.query_ast_optimizer import optimize_ast, compute_ast_complexity
from ..services.query_sql_cache import get_sql_cache
from .interfaces import QueryRepository
from .base import BasePostgresRepository
from ...db.connection import acquire_connection
from ...logging_config import get_logger

logger = get_logger(__name__)


class PostgresQueryRepository(BasePostgresRepository, QueryRepository):
    """Executes generated queries and returns results."""

    def __init__(self, pool, workspace_id: int, user_id: Optional[str] = None):
        super().__init__(pool, workspace_id, int(user_id) if user_id else None)
        self._sql_cache = get_sql_cache()

    def _substitute_params(self, query_ast: QueryAST, runtime_params: Dict[str, Any]) -> QueryAST:
        """Substitute runtime parameters in QueryAST."""
        import copy
        logger.info(f"[_substitute_params] runtime_params={runtime_params}")
        query_ast = copy.deepcopy(query_ast)

        if hasattr(query_ast.scope, 'excluded_page_uuids') and query_ast.scope.excluded_page_uuids:
            query_ast.scope.excluded_page_uuids = [
                self._resolve_placeholder(uuid, runtime_params)
                for uuid in query_ast.scope.excluded_page_uuids
            ]

        self._substitute_in_group(query_ast.root_group, runtime_params)
        return query_ast

    def _substitute_in_group(self, group, runtime_params: Dict[str, Any]):
        """Recursively substitute parameters in a group."""
        from ..entities.query_ast import (
            GroupNode, ClassCondition, ExtendsCondition, ReferenceCondition,
            ReferencePathCondition, NotNode,
            PropertyCondition, ParentCondition, ContentCondition
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
                    child.child.extends_class_uuid = self._resolve_placeholder(child.child.extends_class_uuid, runtime_params)
                elif isinstance(child.child, ReferenceCondition):
                    child.child.target_uuid = self._resolve_placeholder(child.child.target_uuid, runtime_params)
                elif isinstance(child.child, ReferencePathCondition):
                    if child.child.target_uuids:
                        child.child.target_uuids = [self._resolve_placeholder(u, runtime_params) for u in child.child.target_uuids]
                    if child.child.nested_group:
                        self._substitute_in_group(child.child.nested_group, runtime_params)
                elif isinstance(child.child, ContentCondition):
                    child.child.value = self._resolve_placeholder(child.child.value, runtime_params)
                elif isinstance(child.child, PropertyCondition):
                    child.child.value = self._resolve_placeholder(child.child.value, runtime_params)
                elif isinstance(child.child, ParentCondition):
                    if child.child.parent_uuid:
                        logger.info(f"[_substitute_in_group] NOT>ParentCondition parent_uuid before: {child.child.parent_uuid}")
                        child.child.parent_uuid = self._resolve_placeholder(child.child.parent_uuid, runtime_params)
                        logger.info(f"[_substitute_in_group] NOT>ParentCondition parent_uuid after: {child.child.parent_uuid}")
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
            elif isinstance(child, PropertyCondition):
                child.value = self._resolve_placeholder(child.value, runtime_params)
            elif isinstance(child, ContentCondition):
                child.value = self._resolve_placeholder(child.value, runtime_params)
            elif isinstance(child, ParentCondition):
                logger.info(f"[_substitute_in_group] ParentCondition found, parent_uuid={child.parent_uuid}")
                if child.parent_uuid:
                    logger.info(f"[_substitute_in_group] ParentCondition parent_uuid before: {child.parent_uuid}")
                    child.parent_uuid = self._resolve_placeholder(child.parent_uuid, runtime_params)
                    logger.info(f"[_substitute_in_group] ParentCondition parent_uuid after: {child.parent_uuid}")
                if child.nested_group:
                    self._substitute_in_group(child.nested_group, runtime_params)

    def _resolve_placeholder(self, value: str, runtime_params: Dict[str, Any]) -> str:
        """Resolve a single placeholder value."""
        if not isinstance(value, str) or not value.startswith('{'):
            return value

        if '{current_node_name}' in value:
            name_value = runtime_params.get('current_node_name', '')
            if not name_value:
                logger.warning(f"Placeholder {{current_node_name}} used but no runtime value provided")
            return value.replace('{current_node_name}', name_value)
        elif '{current_node_uuid}' in value:
            uuid_value = runtime_params.get('current_node_uuid', '')
            if not uuid_value:
                logger.warning(f"Placeholder {{current_node_uuid}} used but no runtime value provided")
            return value.replace('{current_node_uuid}', uuid_value)
        elif '{current_node_id}' in value:
            id_value = runtime_params.get('current_node_id', '')
            if not id_value:
                logger.warning(f"Placeholder {{current_node_id}} used but no runtime value provided")
            return value.replace('{current_node_id}', str(id_value))
        elif '{current_user_id}' in value:
            user_value = self._user_id or runtime_params.get('current_user_id', '')
            if not user_value:
                logger.warning(f"Placeholder {{current_user_id}} used but no runtime value provided")
            return value.replace('{current_user_id}', str(user_value))

        return value

    async def execute_query(
        self,
        query: Union[Dict[str, Any], QueryAST],
        runtime_params: Optional[Dict[str, Any]] = None,
        limit: Optional[int] = None,
        offset: Optional[int] = None,
        order_by: Optional[str] = None,
        enrich: Optional[Dict[str, bool]] = None,
    ) -> Dict[str, Any]:
        """Execute a query and return results with optional pagination metadata."""
        t_start = time.monotonic()

        if isinstance(query, dict):
            query_ast = QueryAST.from_dict(query)
        else:
            query_ast = query

        query_ast = self._substitute_params(query_ast, runtime_params or {})

        ast_metrics = compute_ast_complexity(query_ast)
        query_ast = optimize_ast(query_ast)
        ast_metrics_after = compute_ast_complexity(query_ast)

        current_node_uuid = runtime_params.get('current_node_uuid') if runtime_params else None
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
            if limit is not None or offset is not None:
                count_sql = f"SELECT COUNT(*) as count FROM ({base_sql}) subq"
                count_params = list(params.values())
                count_row = await conn.fetchrow(count_sql, *count_params)
                total_count = count_row['count'] if count_row else 0

        t_sql_end = time.monotonic()

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

        response: Dict[str, Any] = {
            "nodes": results,
            "metrics": metrics,
        }
        if total_count is not None:
            response["total_count"] = total_count

        return response

    async def execute_query_legacy(
        self,
        query: Union[Dict[str, Any], QueryAST],
        runtime_params: Optional[Dict[str, Any]] = None,
        limit: Optional[int] = None,
        offset: Optional[int] = None,
        order_by: Optional[str] = None,
    ) -> List[Dict[str, Any]]:
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
        current_node_uuid: Optional[str],
    ) -> tuple:
        """Generate SQL, using cache for repeated AST structures."""
        generator = QueryASTToSQL(self._workspace_id, current_node_uuid)
        sql, params = generator.generate(query_ast)
        return sql, params, False

    def _rows_to_dicts(self, rows) -> List[Dict[str, Any]]:
        """Convert asyncpg Row objects to plain dicts."""
        results = []
        for row in rows:
            node_dict = dict(row)
            if 'uuid' in node_dict:
                node_dict['uuid'] = str(node_dict['uuid'])
            if 'page_uuid' in node_dict and node_dict['page_uuid']:
                node_dict['page_uuid'] = str(node_dict['page_uuid'])
            for key in ('create_date', 'write_date', 'open_date'):
                if key in node_dict and node_dict[key]:
                    if isinstance(node_dict[key], datetime):
                        node_dict[key] = node_dict[key].isoformat()
            results.append(node_dict)
        return results

    async def count_query_results(
        self,
        query: Union[Dict[str, Any], QueryAST],
        runtime_params: Optional[Dict[str, Any]] = None,
    ) -> int:
        """Count results for a query without fetching all data."""
        if isinstance(query, dict):
            query_ast = QueryAST.from_dict(query)
        else:
            query_ast = query

        query_ast = self._substitute_params(query_ast, runtime_params or {})
        query_ast = optimize_ast(query_ast)

        current_node_uuid = runtime_params.get('current_node_uuid') if runtime_params else None
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

        return row['count'] if row else 0
