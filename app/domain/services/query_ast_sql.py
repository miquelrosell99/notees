"""Query AST to SQL Generator

Converts QueryAST structures to PostgreSQL queries.
Generates optimized SQL with proper indexing and filtering.
"""
from typing import List, Dict, Any, Optional, Tuple
from datetime import datetime

from app.domain.entities.query_ast import (
    QueryAST,
    ScopeNode,
    GroupNode,
    ConditionNode,
    NotNode,
    TypeCondition,
    PropertyCondition,
    ContentCondition,
    ReferenceCondition,
    ReferencePathCondition,
    ParentPathCondition,
    ParentCondition,
    FlagCondition,
    LogicType,
    ScopeType,
)


class QueryASTToSQL:
    """Converts QueryAST to PostgreSQL queries."""
    
    def __init__(self, graph_id: int, current_node_uuid: Optional[str] = None):
        """
        Initialize the SQL generator.
        
        Args:
            graph_id: The graph ID to query within
            current_node_uuid: UUID of the current node (for placeholder substitution)
        """
        self.graph_id = graph_id
        self.current_node_uuid = current_node_uuid
        self.params: Dict[str, Any] = {'graph_id': graph_id}
        # Add current_uuid to params if provided
        if current_node_uuid:
            self.params['current_uuid'] = current_node_uuid
        self.param_counter = 0
    
    def generate(self, ast: QueryAST) -> Tuple[str, Dict[str, Any]]:
        """
        Generate SQL query from AST.
        
        Returns:
            (sql, params) tuple
        """
        # Base SELECT with all node fields
        sql_parts = [
            "SELECT DISTINCT n.*",
            "FROM node n",
        ]
        
        # Generate WHERE clause from scope and conditions
        where_clauses = []
        
        # Always filter by graph_id and active
        where_clauses.append("n.graph_id = %(graph_id)s")
        where_clauses.append("n.active = TRUE")
        
        # Add scope filtering
        scope_clause = self._generate_scope_sql(ast.scope)
        if scope_clause:
            where_clauses.append(scope_clause)
        
        # Add root group conditions
        if ast.root_group.children:
            group_clause = self._generate_group_sql(ast.root_group)
            if group_clause:
                where_clauses.append(f"({group_clause})")
        
        # Combine WHERE clauses
        if where_clauses:
            sql_parts.append("WHERE " + " AND ".join(where_clauses))
        
        # Default ordering
        sql_parts.append("ORDER BY n.id DESC")
        
        # Combine into final SQL
        sql = "\n".join(sql_parts)
        
        return sql, self.params
    
    def _generate_scope_sql(self, scope: ScopeNode) -> Optional[str]:
        """Generate SQL for scope filtering."""
        if scope.scope_type == ScopeType.ENTIRE_GRAPH:
            # No additional filtering needed
            return None
        
        elif scope.scope_type == ScopeType.PAGES:
            # Only pages (is_page = true)
            return "n.is_page = TRUE"
        
        elif scope.scope_type == ScopeType.CURRENT_PAGE:
            if not self.current_node_uuid:
                return None
            
            # Filter to current page or its descendants
            if scope.include_descendants:
                # Get all nodes under current page
                return f"(n.page_id = (SELECT id FROM node WHERE uuid = %(current_uuid)s AND graph_id = %(graph_id)s))"
            else:
                # Only the current page itself
                return f"(n.uuid = %(current_uuid)s)"
        
        elif scope.scope_type == ScopeType.SPECIFIC_PAGES:
            if not scope.page_uuids:
                return None
            
            # Filter to specific pages
            param_name = self._add_param(scope.page_uuids)
            
            if scope.include_descendants:
                # Pages and their descendants
                return f"(n.page_id IN (SELECT id FROM node WHERE uuid = ANY(%({param_name})s) AND graph_id = %(graph_id)s))"
            else:
                # Only the pages themselves
                return f"(n.uuid = ANY(%({param_name})s))"
        
        elif scope.scope_type == ScopeType.LINKED_REFS:
            if not self.current_node_uuid:
                return None
            
            # Nodes that link to current node
            return """(n.id IN (
                SELECT source_id FROM node_link
                WHERE target_id = (SELECT id FROM node WHERE uuid = %(current_uuid)s AND graph_id = %(graph_id)s)
                AND graph_id = %(graph_id)s
            ))"""
        
        return None
    
    def _generate_group_sql(self, group: GroupNode) -> Optional[str]:
        """Generate SQL for a group of conditions."""
        if not group.children:
            return None
        
        child_clauses = []
        
        for child in group.children:
            if isinstance(child, GroupNode):
                # Nested group
                nested_sql = self._generate_group_sql(child)
                if nested_sql:
                    child_clauses.append(f"({nested_sql})")
            
            elif isinstance(child, NotNode):
                # NOT condition
                if isinstance(child.child, GroupNode):
                    nested_sql = self._generate_group_sql(child.child)
                    if nested_sql:
                        child_clauses.append(f"NOT ({nested_sql})")
                else:
                    cond_sql = self._generate_condition_sql(child.child)
                    if cond_sql:
                        child_clauses.append(f"NOT ({cond_sql})")
            
            else:
                # Regular condition
                cond_sql = self._generate_condition_sql(child)
                if cond_sql:
                    child_clauses.append(cond_sql)
        
        if not child_clauses:
            return None
        
        # Combine with AND or OR
        logic_op = " AND " if group.logic == LogicType.AND else " OR "
        return logic_op.join(child_clauses)
    
    def _generate_condition_sql(self, condition: ConditionNode) -> Optional[str]:
        """Generate SQL for a single condition."""
        if isinstance(condition, TypeCondition):
            return self._generate_type_condition(condition)
        elif isinstance(condition, PropertyCondition):
            return self._generate_property_condition(condition)
        elif isinstance(condition, ContentCondition):
            return self._generate_content_condition(condition)
        elif isinstance(condition, ReferenceCondition):
            return self._generate_reference_condition(condition)
        elif isinstance(condition, ReferencePathCondition):
            return self._generate_reference_path_condition(condition)
        elif isinstance(condition, ParentPathCondition):
            return self._generate_parent_path_condition(condition)
        elif isinstance(condition, ParentCondition):
            return self._generate_parent_condition(condition)
        elif isinstance(condition, FlagCondition):
            return self._generate_flag_condition(condition)
        
        return None
    
    def _generate_type_condition(self, condition: TypeCondition) -> Optional[str]:
        """Generate SQL for type/class condition."""
        if not condition.type_uuid:
            return None
        
        param_name = self._add_param(condition.type_uuid)
        
        # Check if node has this type via node_class_inline
        return f"""(n.id IN (
            SELECT node_id FROM node_class_inline
            WHERE class_node_id = (SELECT id FROM node WHERE uuid = %({param_name})s AND graph_id = %(graph_id)s)
            AND graph_id = %(graph_id)s
        ))"""
    
    def _generate_property_condition(self, condition: PropertyCondition) -> Optional[str]:
        """Generate SQL for property condition.
        
        Handles both:
        - Built-in node columns (uuid, name, id, etc.)
        - Custom properties stored in property_value_* tables
        """
        if not condition.property_name:
            return None
        
        # Built-in node columns that should be queried directly
        BUILTIN_COLUMNS = {'uuid', 'name', 'id', 'parent_id', 'is_page', 'is_favorite'}
        
        # Check if this is a built-in column
        if condition.property_name in BUILTIN_COLUMNS:
            # For IS_EMPTY/IS_NOT_EMPTY on built-in columns
            if condition.operator == 'is_empty':
                return f"n.{condition.property_name} IS NULL"
            elif condition.operator == 'is_not_empty':
                return f"n.{condition.property_name} IS NOT NULL"
            
            # For value-based operators
            if condition.value is None:
                return None
            
            # Don't add property name as parameter for built-in columns
            value_param = self._add_param(str(condition.value))
            column_name = condition.property_name
            
            # Special handling for UUID columns
            if column_name == 'uuid':
                if condition.operator == 'equals':
                    return f"n.{column_name}::text = %({value_param})s"
                elif condition.operator == 'not_equals':
                    return f"n.{column_name}::text != %({value_param})s"
            
            # Standard text comparison for other columns
            if condition.operator == 'equals':
                return f"n.{column_name}::text = %({value_param})s"
            elif condition.operator == 'not_equals':
                return f"n.{column_name}::text != %({value_param})s"
            elif condition.operator == 'contains':
                return f"n.{column_name}::text ILIKE '%%' || %({value_param})s || '%%'"
            elif condition.operator == 'greater_than':
                return f"n.{column_name}::numeric > %({value_param})s::numeric"
            elif condition.operator == 'less_than':
                return f"n.{column_name}::numeric < %({value_param})s::numeric"
        
        # Custom property - query property_value_scalar table
        else:
            # Add property name as parameter for custom properties
            prop_param = self._add_param(condition.property_name)
            
            if condition.operator == 'is_empty':
                return f"NOT EXISTS (SELECT 1 FROM node_property WHERE node_id = n.id AND name = %({prop_param})s)"
            
            elif condition.operator == 'is_not_empty':
                return f"EXISTS (SELECT 1 FROM node_property WHERE node_id = n.id AND name = %({prop_param})s)"
            
            # For value-based operators
            if condition.value is None:
                return None
            
            value_param = self._add_param(condition.value)
            
            if condition.operator == 'equals':
                # Check in property_value_scalar table
                return f"""EXISTS (
                    SELECT 1 FROM node_property np
                    JOIN property_value_scalar pvs ON pvs.node_property_id = np.id
                    WHERE np.node_id = n.id 
                    AND pvs.value_text = %({value_param})s
                )"""
            
            elif condition.operator == 'not_equals':
                return f"""EXISTS (
                    SELECT 1 FROM node_property np
                    JOIN property_value_scalar pvs ON pvs.node_property_id = np.id
                    WHERE np.node_id = n.id 
                    AND pvs.value_text != %({value_param})s
                )"""
            
            elif condition.operator == 'contains':
                return f"""EXISTS (
                    SELECT 1 FROM node_property np
                    JOIN property_value_scalar pvs ON pvs.node_property_id = np.id
                    WHERE np.node_id = n.id 
                    AND pvs.value_text ILIKE '%%' || %({value_param})s || '%%'
                )"""
            
            elif condition.operator == 'greater_than':
                return f"""EXISTS (
                    SELECT 1 FROM node_property np
                    JOIN property_value_scalar pvs ON pvs.node_property_id = np.id
                    WHERE np.node_id = n.id 
                    AND pvs.value_float > %({value_param})s::numeric
                )"""
            
            elif condition.operator == 'less_than':
                return f"""EXISTS (
                    SELECT 1 FROM node_property np
                    JOIN property_value_scalar pvs ON pvs.node_property_id = np.id
                    WHERE np.node_id = n.id 
                    AND pvs.value_float < %({value_param})s::numeric
                )"""
        
        return None
    
    def _generate_content_condition(self, condition: ContentCondition) -> Optional[str]:
        """Generate SQL for content/name search condition."""
        if not condition.value:
            return None
        
        value_param = self._add_param(condition.value)
        
        if condition.operator == 'contains':
            if condition.case_sensitive:
                return f"n.name LIKE '%%' || %({value_param})s || '%%'"
            else:
                return f"n.name ILIKE '%%' || %({value_param})s || '%%'"
        
        elif condition.operator == 'starts_with':
            if condition.case_sensitive:
                return f"n.name LIKE %({value_param})s || '%%'"
            else:
                return f"n.name ILIKE %({value_param})s || '%%'"
        
        elif condition.operator == 'ends_with':
            if condition.case_sensitive:
                return f"n.name LIKE '%%' || %({value_param})s"
            else:
                return f"n.name ILIKE '%%' || %({value_param})s"
        
        elif condition.operator == 'equals':
            if condition.case_sensitive:
                return f"n.name = %({value_param})s"
            else:
                return f"LOWER(n.name) = LOWER(%({value_param})s)"
        
        elif condition.operator == 'regex':
            return f"n.name ~ %({value_param})s"
        
        return None
    
    def _generate_reference_condition(self, condition: ReferenceCondition) -> Optional[str]:
        """Generate SQL for reference condition."""
        if not condition.target_uuid:
            return None
        
        param_name = self._add_param(condition.target_uuid)
        
        # Check if node has a link to target
        return f"""(EXISTS (
            SELECT 1 FROM node_link
            WHERE source_id = n.id
            AND target_id = (SELECT id FROM node WHERE uuid = %({param_name})s AND graph_id = %(graph_id)s)
            AND graph_id = %(graph_id)s
        ))"""
    
    def _generate_reference_path_condition(self, condition: ReferencePathCondition) -> Optional[str]:
        """Generate SQL for reference path condition (nodes that reference nodes matching criteria)."""
        # This would need a subquery with the nested group
        # Simplified for now
        return None
    
    def _generate_parent_path_condition(self, condition: ParentPathCondition) -> Optional[str]:
        """Generate SQL for parent path condition.
        
        This finds nodes that are descendants of nodes matching the nested group.
        For child_pages view: finds direct children (max_depth=1) of the current node.
        """
        if not condition.group or not condition.group.blocks:
            return None
        
        # Get the first block in the group - typically a UUID block
        first_block = condition.group.blocks[0]
        
        # Handle UUID block (most common case for current_node_uuid)
        if hasattr(first_block, 'value'):
            uuid_value = first_block.value
            param_name = self._add_param(uuid_value)
            
            # Build the node_path query
            depth_condition = ""
            if condition.max_depth is not None:
                depth_param = self._add_param(condition.max_depth)
                depth_condition = f" AND np.depth = %({depth_param})s"
            elif condition.min_depth is not None:
                min_depth_param = self._add_param(condition.min_depth)
                depth_condition = f" AND np.depth >= %({min_depth_param})s"
            
            return f"""(EXISTS (
                SELECT 1 FROM node_path np
                WHERE np.descendant_id = n.id
                AND np.ancestor_id = (SELECT id FROM node WHERE uuid = %({param_name})s AND graph_id = %(graph_id)s)
                {depth_condition}
            ))"""
        
        return None
    
    def _generate_flag_condition(self, condition: FlagCondition) -> Optional[str]:
        """Generate SQL for flag condition (is_page, is_day, etc)."""
        if not condition.flag_name:
            return None
        
        # Direct boolean column check
        if condition.value:
            return f"n.{condition.flag_name} = TRUE"
        else:
            return f"(n.{condition.flag_name} = FALSE OR n.{condition.flag_name} IS NULL)"
    
    def _generate_parent_condition(self, condition: ParentCondition) -> Optional[str]:
        """Generate SQL for parent condition - direct parent match.
        
        Supports two modes:
        - Static: parent_uuid specified directly
        - Dynamic: nested_group filters parent nodes
        """
        from app.logging_config import get_logger
        logger = get_logger(__name__)
        
        # Handle operator - default to 'has_parent' if not specified
        operator = getattr(condition, 'operator', 'has_parent')
        
        # Static mode: direct parent UUID/ID
        if condition.parent_uuid:
            # Skip if parent_uuid is empty string (failed placeholder resolution)
            if condition.parent_uuid.strip() == '':
                logger.warning("Parent condition has empty parent_uuid after placeholder resolution")
                return None
            
            # Check for unresolved placeholder - this should have been resolved before SQL generation
            if '{' in condition.parent_uuid and '}' in condition.parent_uuid:
                logger.error(f"Unresolved placeholder in parent_uuid: {condition.parent_uuid}")
                # Don't generate SQL with unresolved placeholder - it will match nothing
                return None
            
            param_name = self._add_param(condition.parent_uuid)
            logger.debug(f"Generating parent condition SQL with uuid={condition.parent_uuid}, operator={operator}")
            if operator == 'has_no_parent':
                # Negate the condition
                return f"n.parent_id != (SELECT id FROM node WHERE uuid = %({param_name})s AND graph_id = %(graph_id)s)"
            else:  # has_parent (default)
                return f"n.parent_id = (SELECT id FROM node WHERE uuid = %({param_name})s AND graph_id = %(graph_id)s)"
        
        # Dynamic mode: nested group filters
        if not condition.nested_group:
            # If no parent_uuid and no nested_group, handle based on operator
            if operator == 'has_no_parent':
                return "n.parent_id IS NULL"
            # For has_parent without specification, this is invalid - return None
            return None
        
        # Generate SQL for the nested group that filters parent nodes
        nested_sql = self._generate_group_sql(condition.nested_group)
        if not nested_sql:
            return None
        
        # Replace all references to 'n.' in nested SQL with 'parent_n.' to refer to parent node
        # Need to handle various patterns: " n.", "(n.", "=n.", etc.
        import re
        parent_sql = re.sub(r'\bn\.', 'parent_n.', nested_sql)
        
        if operator == 'has_no_parent':
            # Negate: node must NOT have a parent matching the criteria
            return f"""n.parent_id NOT IN (
                SELECT parent_n.id FROM node parent_n
                WHERE parent_n.graph_id = %(graph_id)s AND parent_n.active = TRUE
                AND ({parent_sql})
            )"""
        else:  # has_parent (default)
            return f"""n.parent_id IN (
                SELECT parent_n.id FROM node parent_n
                WHERE parent_n.graph_id = %(graph_id)s AND parent_n.active = TRUE
                AND ({parent_sql})
            )"""
    
    def _add_param(self, value: Any) -> str:
        """Add a parameter and return its name."""
        param_name = f'p{self.param_counter}'
        self.params[param_name] = value
        self.param_counter += 1
        return param_name


def generate_sql_from_ast(
    ast: QueryAST,
    graph_id: int,
    current_node_uuid: Optional[str] = None
) -> Tuple[str, Dict[str, Any]]:
    """
    Generate SQL query from QueryAST.
    
    Args:
        ast: The QueryAST to convert
        graph_id: The graph ID to query within
        current_node_uuid: UUID of current node for placeholder substitution
    
    Returns:
        (sql, params) tuple
    """
    generator = QueryASTToSQL(graph_id, current_node_uuid)
    return generator.generate(ast)
