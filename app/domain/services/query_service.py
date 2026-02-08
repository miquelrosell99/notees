"""Query execution service.

Executes queries using QueryASTToSQL for SQL generation.
Handles parameter substitution, SQL execution, and result formatting.
"""
from __future__ import annotations

import re
from datetime import datetime
from typing import Optional, List, Dict, Any, Union

from ..entities.query_ast import QueryAST
from .query_ast_sql import QueryASTToSQL
from ...db.connection import acquire_connection
from ...logging_config import get_logger

logger = get_logger(__name__)


class QueryExecutor:
    """Executes generated queries and returns results."""
    
    def __init__(self, pool, graph_id: int, user_id: Optional[str] = None):
        """Initialize the query executor.
        
        Args:
            pool: asyncpg connection pool
            graph_id: Current graph ID
            user_id: Current user ID (string)
        """
        self._pool = pool
        self._graph_id = graph_id
        self._user_id = user_id
    
    def _substitute_params(self, query_ast: QueryAST, runtime_params: Dict[str, Any]) -> QueryAST:
        """Substitute runtime parameters in QueryAST.
        
        Replaces placeholders like {current_node_uuid} with actual values.
        """
        import copy
        logger.info(f"[_substitute_params] runtime_params={runtime_params}")
        query_ast = copy.deepcopy(query_ast)
        
        # Substitute in scope (page_uuids is no longer part of ScopeNode)
        # ScopeNode uses scope_type and excluded_page_uuids instead
        if hasattr(query_ast.scope, 'excluded_page_uuids') and query_ast.scope.excluded_page_uuids:
            query_ast.scope.excluded_page_uuids = [
                self._resolve_placeholder(uuid, runtime_params)
                for uuid in query_ast.scope.excluded_page_uuids
            ]
        
        # Substitute in conditions recursively
        self._substitute_in_group(query_ast.root_group, runtime_params)
        
        return query_ast
    
    def _substitute_in_group(self, group, runtime_params: Dict[str, Any]):
        """Recursively substitute parameters in a group."""
        from ..entities.query_ast import (
            GroupNode, ClassCondition, ExtendsCondition, ReferenceCondition, NotNode, 
            PropertyCondition, ParentCondition
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
            elif isinstance(child, PropertyCondition):
                child.value = self._resolve_placeholder(child.value, runtime_params)
            elif isinstance(child, ParentCondition):
                # ParentCondition can have parent_uuid (static) or nested_group (dynamic)
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
        
        # Replace known placeholders
        if '{current_node_uuid}' in value:
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
        limit: Optional[int] = 100,
        offset: Optional[int] = None,
        order_by: Optional[str] = None,
    ) -> List[Dict[str, Any]]:
        """Execute a query and return results.
        
        Args:
            query: The QueryAST (as object or dict)
            runtime_params: Runtime parameter values
            limit: Maximum results to return
            offset: Offset for pagination
            order_by: Order clause
            
        Returns:
            List of node dictionaries
        """
        # Convert dict to QueryAST if needed
        if isinstance(query, dict):
            query_ast = QueryAST.from_dict(query)
        else:
            query_ast = query
        
        # Substitute runtime parameters
        query_ast = self._substitute_params(query_ast, runtime_params or {})
        
        # Generate SQL using new QueryASTToSQL
        # Pass current_node_uuid from runtime params if available
        current_node_uuid = runtime_params.get('current_node_uuid') if runtime_params else None
        generator = QueryASTToSQL(self._graph_id, current_node_uuid)
        sql, params_dict = generator.generate(query_ast)
        
        # Convert named params to positional for asyncpg
        # Build ordered list of params and replace placeholders
        params = []
        for param_name, value in params_dict.items():
            params.append(value)
            # Replace ALL occurrences of this named placeholder with positional
            placeholder = f"%({param_name})s"
            positional = f"${len(params)}"
            sql = sql.replace(placeholder, positional)
        
        # Add limit/offset
        if limit:
            sql += f" LIMIT ${len(params) + 1}"
            params.append(limit)
        if offset:
            sql += f" OFFSET ${len(params) + 1}"
            params.append(offset)
        
        logger.debug(f"Executing query SQL: {sql}")
        logger.debug(f"Query params: {params}")
        logger.info(f"[QUERY DEBUG] SQL: {sql}")
        logger.info(f"[QUERY DEBUG] Params: {params}")
        
        async with acquire_connection(self._pool) as conn:
            rows = await conn.fetch(sql, *params)
        
        # Convert rows to dictionaries
        results = []
        for row in rows:
            node_dict = dict(row)
            # Convert UUID to string
            if 'uuid' in node_dict:
                node_dict['uuid'] = str(node_dict['uuid'])
            # Convert page_uuid to string
            if 'page_uuid' in node_dict and node_dict['page_uuid']:
                node_dict['page_uuid'] = str(node_dict['page_uuid'])
            # Convert timestamps to ISO strings
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
        """Count results for a query without fetching all data.
        
        Args:
            query: The QueryAST (as object or dict)
            runtime_params: Runtime parameter values
            
        Returns:
            Count of matching nodes
        """
        # Convert dict to QueryAST if needed
        if isinstance(query, dict):
            query_ast = QueryAST.from_dict(query)
        else:
            query_ast = query
        
        # Substitute runtime parameters
        query_ast = self._substitute_params(query_ast, runtime_params or {})
        
        # Generate SQL using new QueryASTToSQL
        # Pass current_node_uuid from runtime params if available
        current_node_uuid = runtime_params.get('current_node_uuid') if runtime_params else None
        generator = QueryASTToSQL(self._graph_id, current_node_uuid)
        sql, params_dict = generator.generate(query_ast)
        
        # Convert named params to positional
        params = list(params_dict.values())
        
        # Wrap in COUNT query
        count_sql = f"SELECT COUNT(*) as count FROM ({sql}) subq"
        
        async with acquire_connection(self._pool) as conn:
            row = await conn.fetchrow(count_sql, *params)
        
        return row['count'] if row else 0
