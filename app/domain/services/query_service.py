"""Query SQL generation service.

Dynamically generates SQL from query block trees.
Supports nested AND/OR, NOT, REFERENCE, REFERENCE PATH, ANCESTOR PATH blocks.
"""
from __future__ import annotations

import json
import re
from datetime import datetime, date, timezone
from typing import Optional, List, Dict, Any, Tuple, Union

from ..entities.query import (
    QueryBlockType,
    QueryBlockTree,
    QUERY_PLACEHOLDERS,
)
from ...logging_config import get_logger

logger = get_logger(__name__)


class QuerySQLGenerator:
    """Generates SQL from query block trees.
    
    Uses parameterized queries to prevent SQL injection.
    Supports runtime parameter substitution for placeholders.
    """
    
    def __init__(self, graph_id: int, user_id: Optional[str] = None):
        """Initialize the SQL generator.
        
        Args:
            graph_id: Current graph ID for scoping queries
            user_id: Current user ID (string) for permission checks and placeholders
        """
        self._graph_id = graph_id
        self._user_id = user_id
        self._param_counter = 0
        self._params: List[Any] = []
        self._alias_counter = 0
    
    def _next_param(self, value: Any) -> str:
        """Get next parameter placeholder and register the value."""
        self._param_counter += 1
        self._params.append(value)
        return f"${self._param_counter}"
    
    def _next_alias(self, prefix: str = "t") -> str:
        """Get next table alias."""
        self._alias_counter += 1
        return f"{prefix}{self._alias_counter}"
    
    def _resolve_placeholder(
        self, 
        value: str, 
        runtime_params: Dict[str, Any]
    ) -> Any:
        """Resolve a placeholder to its runtime value.
        
        Args:
            value: The value which may contain placeholders like {current_node_uuid}
            runtime_params: Runtime parameter values from the frontend
            
        Returns:
            Resolved value
        """
        if not isinstance(value, str):
            return value
        
        # Check for known placeholders
        if value in QUERY_PLACEHOLDERS:
            if value == "{current_node_uuid}":
                return runtime_params.get("current_node_uuid")
            elif value == "{current_node_id}":
                return runtime_params.get("current_node_id")
            elif value == "{current_user_id}":
                return self._user_id
            elif value == "{today}":
                return date.today().isoformat()
            elif value == "{this_week}":
                today = date.today()
                start_of_week = today.replace(day=today.day - today.weekday())
                return start_of_week.isoformat()
            elif value == "{this_month}":
                return date.today().replace(day=1).isoformat()
            elif value == "{this_year}":
                return date.today().replace(month=1, day=1).isoformat()
        
        # Check for custom placeholders in runtime_params
        placeholder_match = re.match(r'\{(\w+)\}', value)
        if placeholder_match:
            key = placeholder_match.group(1)
            if key in runtime_params:
                return runtime_params[key]
        
        return value
    
    def generate_sql(
        self,
        block_tree: Union[Dict[str, Any], QueryBlockTree],
        runtime_params: Optional[Dict[str, Any]] = None,
        limit: Optional[int] = None,
        offset: Optional[int] = None,
        order_by: Optional[str] = None,
    ) -> Tuple[str, List[Any]]:
        """Generate SQL from a query block tree.
        
        Args:
            block_tree: The query block tree (dict or QueryBlockTree)
            runtime_params: Runtime parameter values for placeholders
            limit: Optional limit for results
            offset: Optional offset for pagination
            order_by: Optional order clause (e.g., "write_date DESC")
            
        Returns:
            Tuple of (SQL query string, parameter values list)
        """
        # Reset state
        self._param_counter = 0
        self._params = []
        self._alias_counter = 0
        
        runtime_params = runtime_params or {}
        
        # Convert to dict if needed
        if isinstance(block_tree, QueryBlockTree):
            block_tree = block_tree.to_dict()
        
        if not block_tree:
            block_tree = {"type": "AND_CONTAINER", "blocks": []}
        
        # Build the WHERE clause
        where_clause = self._generate_where_clause(block_tree, runtime_params, "n")
        
        # Build the full query - include page_name for grouping purposes
        sql = f"""
            SELECT DISTINCT n.*, 
                   page.name AS page_name,
                   page.uuid AS page_uuid
            FROM node n
            LEFT JOIN node page ON page.id = n.page_id AND page.active = TRUE
            WHERE n.graph_id = {self._next_param(self._graph_id)}
              AND n.active = TRUE
        """
        
        if where_clause:
            sql += f" AND ({where_clause})"
        
        # Add ordering
        if order_by:
            # Sanitize order_by to prevent SQL injection
            allowed_columns = {
                "id", "name", "create_date", "write_date", "open_date",
                "sequence", "is_page", "is_class"
            }
            parts = order_by.split()
            if len(parts) >= 1:
                col = parts[0].lower()
                direction = parts[1].upper() if len(parts) > 1 else "ASC"
                if col in allowed_columns and direction in ("ASC", "DESC"):
                    sql += f" ORDER BY n.{col} {direction}"
        else:
            sql += " ORDER BY n.write_date DESC"
        
        # Add pagination
        if limit is not None:
            sql += f" LIMIT {self._next_param(limit)}"
        if offset is not None:
            sql += f" OFFSET {self._next_param(offset)}"
        
        return sql.strip(), self._params
    
    def _generate_where_clause(
        self,
        block: Dict[str, Any],
        runtime_params: Dict[str, Any],
        node_alias: str,
    ) -> str:
        """Generate WHERE clause from a single block.
        
        Args:
            block: The block dictionary
            runtime_params: Runtime parameter values
            node_alias: The alias for the node table (e.g., "n")
            
        Returns:
            SQL WHERE clause fragment
        """
        block_type = block.get("type", "AND_CONTAINER")
        
        if block_type == QueryBlockType.AND_CONTAINER.value:
            return self._generate_and_container(block, runtime_params, node_alias)
        elif block_type == QueryBlockType.OR_CONTAINER.value:
            return self._generate_or_container(block, runtime_params, node_alias)
        elif block_type == QueryBlockType.NOT_CONTAINER.value:
            return self._generate_not_container(block, runtime_params, node_alias)
        elif block_type == QueryBlockType.CLASS.value:
            return self._generate_class_condition(block, runtime_params, node_alias)
        elif block_type == QueryBlockType.PROPERTY.value:
            return self._generate_property_condition(block, runtime_params, node_alias)
        elif block_type == QueryBlockType.CONTENT.value:
            return self._generate_content_condition(block, runtime_params, node_alias)
        elif block_type == QueryBlockType.REFERENCE.value:
            return self._generate_reference_condition(block, runtime_params, node_alias)
        elif block_type == QueryBlockType.REFERENCE_PATH.value:
            return self._generate_reference_path_condition(block, runtime_params, node_alias)
        elif block_type == QueryBlockType.PARENT.value:
            return self._generate_parent_condition(block, runtime_params, node_alias)
        elif block_type == QueryBlockType.PARENT_PATH.value:
            return self._generate_parent_path_condition(block, runtime_params, node_alias)
        elif block_type == QueryBlockType.CHILD.value:
            return self._generate_child_condition(block, runtime_params, node_alias)
        elif block_type == QueryBlockType.CHILD_PATH.value:
            return self._generate_child_path_condition(block, runtime_params, node_alias)
        elif block_type == QueryBlockType.CLASS_PATH.value:
            return self._generate_class_path_condition(block, runtime_params, node_alias)
        elif block_type == QueryBlockType.UUID.value:
            return self._generate_uuid_condition(block, runtime_params, node_alias)
        else:
            logger.warning(f"Unknown block type: {block_type}")
            return "TRUE"
    
    def _generate_and_container(
        self,
        block: Dict[str, Any],
        runtime_params: Dict[str, Any],
        node_alias: str,
    ) -> str:
        """Generate AND container clause."""
        blocks = block.get("blocks", [])
        if not blocks:
            return "TRUE"
        
        clauses = []
        for sub_block in blocks:
            clause = self._generate_where_clause(sub_block, runtime_params, node_alias)
            if clause and clause != "TRUE":
                clauses.append(f"({clause})")
        
        if not clauses:
            return "TRUE"
        return " AND ".join(clauses)
    
    def _generate_or_container(
        self,
        block: Dict[str, Any],
        runtime_params: Dict[str, Any],
        node_alias: str,
    ) -> str:
        """Generate OR container clause."""
        blocks = block.get("blocks", [])
        if not blocks:
            return "TRUE"
        
        clauses = []
        for sub_block in blocks:
            clause = self._generate_where_clause(sub_block, runtime_params, node_alias)
            if clause and clause != "TRUE":
                clauses.append(f"({clause})")
        
        if not clauses:
            return "TRUE"
        return " OR ".join(clauses)
    
    def _generate_not_container(
        self,
        block: Dict[str, Any],
        runtime_params: Dict[str, Any],
        node_alias: str,
    ) -> str:
        """Generate NOT container clause."""
        inner_block = block.get("block")
        if not inner_block:
            return "TRUE"
        
        inner_clause = self._generate_where_clause(inner_block, runtime_params, node_alias)
        if inner_clause and inner_clause != "TRUE":
            return f"NOT ({inner_clause})"
        return "TRUE"
    
    def _generate_class_condition(
        self,
        block: Dict[str, Any],
        runtime_params: Dict[str, Any],
        node_alias: str,
    ) -> str:
        """Generate class filter condition.
        
        Checks if node has the specified class. For system classes with flags
        (page, class, day, month, year, asset, template, comment), uses the 
        is_* flag directly. For other classes, checks class_inline table.
        
        Supports operators: is, is_not, contains, does_not_contain, defined, not_defined
        """
        class_value = block.get("value", "")
        class_id = block.get("type_id")
        operator = block.get("operator", "contains")  # Default to 'contains' for backward compatibility
        
        # Map of system class names to their corresponding node flags
        SYSTEM_CLASS_FLAGS = {
            'page': 'is_page',
            'class': 'is_class',
            'day': 'is_day',
            'month': 'is_month',
            'year': 'is_year',
            'asset': 'is_asset',
            'template': 'is_template',
            'comment': 'is_comment',
        }
        
        # Handle 'defined' and 'not_defined' - check if node has ANY class
        if operator == "defined":
            return f"""
                EXISTS (
                    SELECT 1 FROM class_inline ci
                    WHERE ci.node_id = {node_alias}.id
                )
            """.strip()
        elif operator == "not_defined":
            return f"""
                NOT EXISTS (
                    SELECT 1 FROM class_inline ci
                    WHERE ci.node_id = {node_alias}.id
                )
            """.strip()
        
        # For other operators, we need a class value or id
        if not class_id and not class_value:
            return "TRUE"
        
        # Build the base condition based on class_id or class_value
        if class_id:
            # Use resolved class_id - check class_inline
            param = self._next_param(class_id)
            base_condition = f"""
                EXISTS (
                    SELECT 1 FROM class_inline ci
                    WHERE ci.node_id = {node_alias}.id
                      AND ci.class_id = {param}
                )
            """.strip()
        elif class_value:
            # Resolve placeholder if needed
            resolved_value = self._resolve_placeholder(class_value, runtime_params)
            
            # Check if this is a system class with a flag
            if resolved_value.lower() in SYSTEM_CLASS_FLAGS:
                flag_name = SYSTEM_CLASS_FLAGS[resolved_value.lower()]
                base_condition = f"{node_alias}.{flag_name} = TRUE"
            else:
                # For custom classes, check class_inline with name matching
                # Use ILIKE for 'contains' operator, exact match for 'is'
                if operator == "contains" or operator == "does_not_contain":
                    # Match if class name contains the value (case-insensitive)
                    param = self._next_param(f"%{resolved_value}%")
                    graph_param = self._next_param(self._graph_id)
                    base_condition = f"""
                        EXISTS (
                            SELECT 1 FROM class_inline ci
                            JOIN node class_node ON class_node.id = ci.class_id
                            WHERE ci.node_id = {node_alias}.id
                              AND class_node.name ILIKE {param}
                              AND class_node.graph_id = {graph_param}
                        )
                    """.strip()
                else:
                    # Exact match for 'is' and 'is_not'
                    param = self._next_param(resolved_value)
                    graph_param = self._next_param(self._graph_id)
                    base_condition = f"""
                        EXISTS (
                            SELECT 1 FROM class_inline ci
                            JOIN node class_node ON class_node.id = ci.class_id
                            WHERE ci.node_id = {node_alias}.id
                              AND (class_node.name = {param} OR class_node.uuid::text = {param})
                              AND class_node.graph_id = {graph_param}
                        )
                    """.strip()
        
        # Apply negation for 'is_not' and 'does_not_contain'
        if operator == "is_not" or operator == "does_not_contain":
            return f"NOT ({base_condition})"
        
        return base_condition
    
    def _generate_property_condition(
        self,
        block: Dict[str, Any],
        runtime_params: Dict[str, Any],
        node_alias: str,
    ) -> str:
        """Generate property filter condition."""
        property_name = block.get("property_name", "")
        property_id = block.get("property_id")
        property_type = block.get("property_type", "text")
        operator = block.get("operator", "=")
        value = block.get("value")
        
        # Resolve any placeholders in value
        if isinstance(value, str):
            value = self._resolve_placeholder(value, runtime_params)
        
        if not property_name and not property_id:
            return "TRUE"
        
        # Handle built-in node columns as properties
        BUILTIN_COLUMNS = {
            'parent_id': 'integer',
            'page_id': 'integer',
            'name': 'text',
            'icon': 'text',
            'color': 'text',
            'sequence': 'integer',
            'collapsed': 'boolean',
            'is_page': 'boolean',
            'is_class': 'boolean',
            'is_day': 'boolean',
            'is_month': 'boolean',
            'is_year': 'boolean',
            'is_asset': 'boolean',
            'is_template': 'boolean',
            'is_comment': 'boolean',
        }
        
        if property_name in BUILTIN_COLUMNS:
            col_type = BUILTIN_COLUMNS[property_name]
            col_name = f"{node_alias}.{property_name}"
            
            if operator == "is_empty":
                return f"{col_name} IS NULL"
            elif operator == "is_not_empty":
                return f"{col_name} IS NOT NULL"
            elif operator == "=":
                param = self._next_param(value)
                return f"{col_name} = {param}"
            elif operator == "!=":
                param = self._next_param(value)
                return f"{col_name} != {param}"
            elif col_type in ("integer", "float"):
                param = self._next_param(value)
                if operator == ">":
                    return f"{col_name} > {param}"
                elif operator == ">=":
                    return f"{col_name} >= {param}"
                elif operator == "<":
                    return f"{col_name} < {param}"
                elif operator == "<=":
                    return f"{col_name} <= {param}"
            elif col_type == "text":
                if operator == "contains":
                    param = self._next_param(f"%{value}%")
                    return f"{col_name} ILIKE {param}"
                elif operator == "starts_with":
                    param = self._next_param(f"{value}%")
                    return f"{col_name} ILIKE {param}"
                elif operator == "ends_with":
                    param = self._next_param(f"%{value}")
                    return f"{col_name} ILIKE {param}"
            return "TRUE"
        
        # Build property identification for user-defined properties
        if property_id:
            prop_condition = f"np.property_id = {self._next_param(property_id)}"
        else:
            prop_condition = f"p.name = {self._next_param(property_name)}"
        
        # Handle different property types
        if property_type in ("text", "integer", "float", "boolean"):
            return self._generate_scalar_property_condition(
                node_alias, prop_condition, property_type, operator, value
            )
        elif property_type == "selection":
            return self._generate_selection_property_condition(
                node_alias, prop_condition, operator, value
            )
        elif property_type == "node":
            return self._generate_node_property_condition(
                node_alias, prop_condition, operator, value
            )
        elif property_type == "date":
            return self._generate_date_property_condition(
                node_alias, prop_condition, operator, value
            )
        else:
            return "TRUE"
    
    def _generate_scalar_property_condition(
        self,
        node_alias: str,
        prop_condition: str,
        property_type: str,
        operator: str,
        value: Any,
    ) -> str:
        """Generate condition for scalar property types."""
        # Determine the value column based on property type
        value_col_map = {
            "text": "pvs.value_text",
            "integer": "pvs.value_integer",
            "float": "pvs.value_float",
            "boolean": "pvs.value_boolean",
        }
        value_col = value_col_map.get(property_type, "pvs.value_text")
        
        # Build the comparison
        if operator in ("is_empty", "is_not_empty"):
            null_check = "IS NULL" if operator == "is_empty" else "IS NOT NULL"
            comparison = f"{value_col} {null_check}"
        elif operator == "contains":
            param = self._next_param(f"%{value}%")
            comparison = f"{value_col} ILIKE {param}"
        elif operator == "starts_with":
            param = self._next_param(f"{value}%")
            comparison = f"{value_col} ILIKE {param}"
        elif operator == "ends_with":
            param = self._next_param(f"%{value}")
            comparison = f"{value_col} ILIKE {param}"
        elif operator in ("in", "not_in"):
            if isinstance(value, list):
                param = self._next_param(value)
                op = "= ANY" if operator == "in" else "!= ALL"
                comparison = f"{value_col} {op}({param})"
            else:
                return "TRUE"
        else:
            # Standard comparison operators
            sql_operator = operator if operator in ("=", "!=", ">", ">=", "<", "<=") else "="
            param = self._next_param(value)
            comparison = f"{value_col} {sql_operator} {param}"
        
        return f"""
            EXISTS (
                SELECT 1 FROM property_value_scalar pvs
                JOIN node_property np ON np.id = pvs.node_property_id
                JOIN property p ON p.id = np.property_id
                WHERE pvs.node_id = {node_alias}.id
                  AND {prop_condition}
                  AND {comparison}
            )
        """.strip()
    
    def _generate_selection_property_condition(
        self,
        node_alias: str,
        prop_condition: str,
        operator: str,
        value: Any,
    ) -> str:
        """Generate condition for selection property types."""
        if operator in ("is_empty", "is_not_empty"):
            exists = "NOT EXISTS" if operator == "is_empty" else "EXISTS"
            return f"""
                {exists} (
                    SELECT 1 FROM property_value_selection pvsel
                    JOIN node_property np ON np.id = pvsel.node_property_id
                    JOIN property p ON p.id = np.property_id
                    WHERE pvsel.node_id = {node_alias}.id
                      AND {prop_condition}
                )
            """.strip()
        
        # Match by selection line name or id
        if operator == "=":
            param = self._next_param(value)
            return f"""
                EXISTS (
                    SELECT 1 FROM property_value_selection pvsel
                    JOIN node_property np ON np.id = pvsel.node_property_id
                    JOIN property p ON p.id = np.property_id
                    JOIN property_selection_line psl ON psl.id = pvsel.selection_line_id
                    WHERE pvsel.node_id = {node_alias}.id
                      AND {prop_condition}
                      AND (psl.name = {param} OR psl.id::text = {param})
                )
            """.strip()
        elif operator == "!=":
            param = self._next_param(value)
            return f"""
                NOT EXISTS (
                    SELECT 1 FROM property_value_selection pvsel
                    JOIN node_property np ON np.id = pvsel.node_property_id
                    JOIN property p ON p.id = np.property_id
                    JOIN property_selection_line psl ON psl.id = pvsel.selection_line_id
                    WHERE pvsel.node_id = {node_alias}.id
                      AND {prop_condition}
                      AND (psl.name = {param} OR psl.id::text = {param})
                )
            """.strip()
        
        return "TRUE"
    
    def _generate_node_property_condition(
        self,
        node_alias: str,
        prop_condition: str,
        operator: str,
        value: Any,
    ) -> str:
        """Generate condition for node relation property types."""
        if operator in ("is_empty", "is_not_empty"):
            exists = "NOT EXISTS" if operator == "is_empty" else "EXISTS"
            return f"""
                {exists} (
                    SELECT 1 FROM property_value_relation pvr
                    JOIN node_property np ON np.id = pvr.node_property_id
                    JOIN property p ON p.id = np.property_id
                    WHERE pvr.node_id = {node_alias}.id
                      AND {prop_condition}
                )
            """.strip()
        
        # Match by target node id or uuid
        if operator == "=":
            param = self._next_param(value)
            return f"""
                EXISTS (
                    SELECT 1 FROM property_value_relation pvr
                    JOIN node_property np ON np.id = pvr.node_property_id
                    JOIN property p ON p.id = np.property_id
                    JOIN node target ON target.id = pvr.target_id
                    WHERE pvr.node_id = {node_alias}.id
                      AND {prop_condition}
                      AND (target.id::text = {param} OR target.uuid::text = {param})
                )
            """.strip()
        
        return "TRUE"
    
    def _generate_date_property_condition(
        self,
        node_alias: str,
        prop_condition: str,
        operator: str,
        value: Any,
    ) -> str:
        """Generate condition for date property types (stored as node relations)."""
        # Dates are stored as relations to date nodes (day/month/year)
        # The date can be extracted from the target node's UUID or is_day/is_month/is_year flags
        
        if operator in ("is_empty", "is_not_empty"):
            exists = "NOT EXISTS" if operator == "is_empty" else "EXISTS"
            return f"""
                {exists} (
                    SELECT 1 FROM property_value_relation pvr
                    JOIN node_property np ON np.id = pvr.node_property_id
                    JOIN property p ON p.id = np.property_id
                    JOIN node target ON target.id = pvr.target_id
                    WHERE pvr.node_id = {node_alias}.id
                      AND {prop_condition}
                      AND (target.is_day = TRUE OR target.is_month = TRUE OR target.is_year = TRUE)
                )
            """.strip()
        
        # For date comparisons, we need to parse the date from the target node name
        # Date nodes have names like "January 15, 2024" or UUID patterns
        param = self._next_param(value)
        sql_op = operator if operator in ("=", "!=", ">", ">=", "<", "<=") else "="
        
        return f"""
            EXISTS (
                SELECT 1 FROM property_value_relation pvr
                JOIN node_property np ON np.id = pvr.node_property_id
                JOIN property p ON p.id = np.property_id
                JOIN node target ON target.id = pvr.target_id
                WHERE pvr.node_id = {node_alias}.id
                  AND {prop_condition}
                  AND target.is_day = TRUE
                  AND target.create_date::date {sql_op} {param}::date
            )
        """.strip()
    
    def _generate_content_condition(
        self,
        block: Dict[str, Any],
        runtime_params: Dict[str, Any],
        node_alias: str,
    ) -> str:
        """Generate content/name filter condition."""
        operator = block.get("operator", "contains")
        value = block.get("value", "")
        case_sensitive = block.get("case_sensitive", False)
        
        value = self._resolve_placeholder(value, runtime_params)
        
        if not value and operator not in ("is_empty", "is_not_empty"):
            return "TRUE"
        
        if operator == "is_empty":
            return f"({node_alias}.name IS NULL OR {node_alias}.name = '')"
        elif operator == "is_not_empty":
            return f"({node_alias}.name IS NOT NULL AND {node_alias}.name != '')"
        elif operator == "=":
            param = self._next_param(value)
            if case_sensitive:
                return f"{node_alias}.name = {param}"
            else:
                return f"LOWER({node_alias}.name) = LOWER({param})"
        elif operator == "contains":
            param = self._next_param(f"%{value}%")
            if case_sensitive:
                return f"{node_alias}.name LIKE {param}"
            else:
                return f"{node_alias}.name ILIKE {param}"
        elif operator == "starts_with":
            param = self._next_param(f"{value}%")
            if case_sensitive:
                return f"{node_alias}.name LIKE {param}"
            else:
                return f"{node_alias}.name ILIKE {param}"
        elif operator == "ends_with":
            param = self._next_param(f"%{value}")
            if case_sensitive:
                return f"{node_alias}.name LIKE {param}"
            else:
                return f"{node_alias}.name ILIKE {param}"
        elif operator == "matches_regex":
            param = self._next_param(value)
            return f"{node_alias}.name ~ {param}"
        elif operator == "fts":
            param = self._next_param(value)
            return f"{node_alias}.search_vector @@ plainto_tsquery('english', {param})"
        
        return "TRUE"
    
    def _generate_reference_condition(
        self,
        block: Dict[str, Any],
        runtime_params: Dict[str, Any],
        node_alias: str,
    ) -> str:
        """Generate reference filter condition.
        
        Finds nodes that reference a specific target node.
        """
        target_uuid = block.get("target_uuid", "")
        target_id = block.get("target_id")
        nested_blocks = block.get("blocks", [])
        
        target_uuid = self._resolve_placeholder(target_uuid, runtime_params)
        
        if not target_uuid and not target_id:
            return "TRUE"
        
        # Build target identification
        if target_id:
            target_condition = f"nl.target_id = {self._next_param(target_id)}"
        else:
            param = self._next_param(target_uuid)
            target_condition = f"target.uuid::text = {param}"
        
        # Base reference query
        base_sql = f"""
            EXISTS (
                SELECT 1 FROM node_link nl
                JOIN node target ON target.id = nl.target_id
                WHERE nl.source_id = {node_alias}.id
                  AND {target_condition}
            )
        """.strip()
        
        # If there are nested blocks, add additional filters on the referencing nodes
        if nested_blocks:
            nested_tree = {"type": "AND_CONTAINER", "blocks": nested_blocks}
            nested_clause = self._generate_where_clause(nested_tree, runtime_params, node_alias)
            if nested_clause and nested_clause != "TRUE":
                return f"({base_sql} AND {nested_clause})"
        
        return base_sql
    
    def _generate_reference_path_condition(
        self,
        block: Dict[str, Any],
        runtime_params: Dict[str, Any],
        node_alias: str,
    ) -> str:
        """Generate reference path filter condition.
        
        Finds nodes that have ancestors (in their parent path) that reference 
        any node matching the nested criteria.
        For example: Find all blocks whose parent path contains a reference to a specific page.
        """
        nested_blocks = block.get("blocks", [])
        
        if not nested_blocks:
            return "TRUE"
        
        # Build subquery for matching target nodes
        target_alias = self._next_alias("ref_target")
        ancestor_alias = self._next_alias("ancestor")
        nested_tree = {"type": "AND_CONTAINER", "blocks": nested_blocks}
        nested_clause = self._generate_where_clause(nested_tree, runtime_params, target_alias)
        
        return f"""
            EXISTS (
                SELECT 1 FROM node_path np
                JOIN node {ancestor_alias} ON {ancestor_alias}.id = np.ancestor_id
                JOIN node_link nl ON nl.source_id = {ancestor_alias}.id
                JOIN node {target_alias} ON {target_alias}.id = nl.target_id
                WHERE np.descendant_id = {node_alias}.id
                  AND np.depth > 0
                  AND {ancestor_alias}.graph_id = {self._next_param(self._graph_id)}
                  AND {ancestor_alias}.active = TRUE
                  AND {target_alias}.graph_id = {self._next_param(self._graph_id)}
                  AND {target_alias}.active = TRUE
                  AND ({nested_clause})
            )
        """.strip()
    
    def _generate_parent_condition(
        self,
        block: Dict[str, Any],
        runtime_params: Dict[str, Any],
        node_alias: str,
    ) -> str:
        """Generate direct parent filter condition.
        
        Finds nodes whose immediate parent matches the nested criteria.
        """
        nested_blocks = block.get("blocks", [])
        
        if not nested_blocks:
            return "TRUE"
        
        # Build subquery for matching parent node
        parent_alias = self._next_alias("parent")
        nested_tree = {"type": "AND_CONTAINER", "blocks": nested_blocks}
        nested_clause = self._generate_where_clause(nested_tree, runtime_params, parent_alias)
        
        return f"""
            EXISTS (
                SELECT 1 FROM node {parent_alias}
                WHERE {parent_alias}.id = {node_alias}.parent_id
                  AND {parent_alias}.graph_id = {self._next_param(self._graph_id)}
                  AND {parent_alias}.active = TRUE
                  AND ({nested_clause})
            )
        """.strip()
    
    def _generate_parent_path_condition(
        self,
        block: Dict[str, Any],
        runtime_params: Dict[str, Any],
        node_alias: str,
    ) -> str:
        """Generate ancestor path filter condition.
        
        Finds nodes that have ancestors matching the nested criteria.
        Uses the node_path closure table for efficient ancestor lookup.
        """
        nested_blocks = block.get("blocks", [])
        max_depth = block.get("max_depth")
        
        if not nested_blocks:
            return "TRUE"
        
        # Build subquery for matching ancestor nodes
        ancestor_alias = self._next_alias("ancestor")
        nested_tree = {"type": "AND_CONTAINER", "blocks": nested_blocks}
        nested_clause = self._generate_where_clause(nested_tree, runtime_params, ancestor_alias)
        
        depth_condition = ""
        if max_depth is not None:
            depth_param = self._next_param(max_depth)
            depth_condition = f"AND np.depth <= {depth_param}"
        
        return f"""
            EXISTS (
                SELECT 1 FROM node_path np
                JOIN node {ancestor_alias} ON {ancestor_alias}.id = np.ancestor_id
                WHERE np.descendant_id = {node_alias}.id
                  AND np.depth > 0
                  {depth_condition}
                  AND {ancestor_alias}.graph_id = {self._next_param(self._graph_id)}
                  AND {ancestor_alias}.active = TRUE
                  AND ({nested_clause})
            )
        """.strip()
    
    def _generate_child_condition(
        self,
        block: Dict[str, Any],
        runtime_params: Dict[str, Any],
        node_alias: str,
    ) -> str:
        """Generate direct child filter condition.
        
        Finds nodes that have at least one immediate child matching the criteria.
        """
        nested_blocks = block.get("blocks", [])
        
        if not nested_blocks:
            return "TRUE"
        
        # Build subquery for matching child nodes
        child_alias = self._next_alias("child")
        nested_tree = {"type": "AND_CONTAINER", "blocks": nested_blocks}
        nested_clause = self._generate_where_clause(nested_tree, runtime_params, child_alias)
        
        return f"""
            EXISTS (
                SELECT 1 FROM node {child_alias}
                WHERE {child_alias}.parent_id = {node_alias}.id
                  AND {child_alias}.graph_id = {self._next_param(self._graph_id)}
                  AND {child_alias}.active = TRUE
                  AND ({nested_clause})
            )
        """.strip()
    
    def _generate_child_path_condition(
        self,
        block: Dict[str, Any],
        runtime_params: Dict[str, Any],
        node_alias: str,
    ) -> str:
        """Generate descendant path filter condition.
        
        Finds nodes that have descendants matching the nested criteria.
        Uses the node_path closure table for efficient descendant lookup.
        """
        nested_blocks = block.get("blocks", [])
        max_depth = block.get("max_depth")
        
        if not nested_blocks:
            return "TRUE"
        
        # Build subquery for matching descendant nodes
        descendant_alias = self._next_alias("descendant")
        nested_tree = {"type": "AND_CONTAINER", "blocks": nested_blocks}
        nested_clause = self._generate_where_clause(nested_tree, runtime_params, descendant_alias)
        
        depth_condition = ""
        if max_depth is not None:
            depth_param = self._next_param(max_depth)
            depth_condition = f"AND np.depth <= {depth_param}"
        
        return f"""
            EXISTS (
                SELECT 1 FROM node_path np
                JOIN node {descendant_alias} ON {descendant_alias}.id = np.descendant_id
                WHERE np.ancestor_id = {node_alias}.id
                  AND np.depth > 0
                  {depth_condition}
                  AND {descendant_alias}.graph_id = {self._next_param(self._graph_id)}
                  AND {descendant_alias}.active = TRUE
                  AND ({nested_clause})
            )
        """.strip()
    
    def _generate_class_path_condition(
        self,
        block: Dict[str, Any],
        runtime_params: Dict[str, Any],
        node_alias: str,
    ) -> str:
        """Generate class path filter condition.
        
        Finds nodes that have specific classes in their classes_path
        (classes inherited from ancestor pages).
        The classes_path column stores class IDs inherited from all ancestors.
        """
        nested_blocks = block.get("blocks", [])
        
        if not nested_blocks:
            return "TRUE"
        
        # Build subquery for matching class nodes
        class_alias = self._next_alias("class_node")
        nested_tree = {"type": "AND_CONTAINER", "blocks": nested_blocks}
        nested_clause = self._generate_where_clause(nested_tree, runtime_params, class_alias)
        
        # Find nodes whose classes_path contains any class matching the criteria
        return f"""
            EXISTS (
                SELECT 1 FROM unnest({node_alias}.classes_path) AS class_id
                JOIN node {class_alias} ON {class_alias}.id = class_id
                WHERE {class_alias}.graph_id = {self._next_param(self._graph_id)}
                  AND {class_alias}.active = TRUE
                  AND ({nested_clause})
            )
        """.strip()
    
    def _generate_uuid_condition(
        self,
        block: Dict[str, Any],
        runtime_params: Dict[str, Any],
        node_alias: str,
    ) -> str:
        """Generate UUID filter condition."""
        value = block.get("value", "")
        value = self._resolve_placeholder(value, runtime_params)
        
        if not value:
            return "TRUE"
        
        param = self._next_param(value)
        return f"{node_alias}.uuid::text = {param}"


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
    
    async def execute_query(
        self,
        block_tree: Union[Dict[str, Any], QueryBlockTree],
        runtime_params: Optional[Dict[str, Any]] = None,
        limit: Optional[int] = 100,
        offset: Optional[int] = None,
        order_by: Optional[str] = None,
    ) -> List[Dict[str, Any]]:
        """Execute a query and return results.
        
        Args:
            block_tree: The query block tree
            runtime_params: Runtime parameter values
            limit: Maximum results to return
            offset: Offset for pagination
            order_by: Order clause
            
        Returns:
            List of node dictionaries
        """
        generator = QuerySQLGenerator(self._graph_id, self._user_id)
        sql, params = generator.generate_sql(
            block_tree,
            runtime_params=runtime_params,
            limit=limit,
            offset=offset,
            order_by=order_by,
        )
        
        logger.debug(f"Executing query SQL: {sql}")
        logger.debug(f"Query params: {params}")
        logger.info(f"[QUERY DEBUG] SQL: {sql}")
        logger.info(f"[QUERY DEBUG] Params: {params}")
        
        async with self._pool.acquire() as conn:
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
        block_tree: Union[Dict[str, Any], QueryBlockTree],
        runtime_params: Optional[Dict[str, Any]] = None,
    ) -> int:
        """Count results for a query without fetching all data.
        
        Args:
            block_tree: The query block tree
            runtime_params: Runtime parameter values
            
        Returns:
            Count of matching nodes
        """
        generator = QuerySQLGenerator(self._graph_id, self._user_id)
        sql, params = generator.generate_sql(
            block_tree,
            runtime_params=runtime_params,
        )
        
        # Wrap in COUNT query
        count_sql = f"SELECT COUNT(*) as count FROM ({sql}) subq"
        
        async with self._pool.acquire() as conn:
            row = await conn.fetchrow(count_sql, *params)
        
        return row['count'] if row else 0
