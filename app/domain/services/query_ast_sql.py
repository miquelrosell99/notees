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
    ClassCondition,
    ExtendsCondition,
    PropertyCondition,
    ContentCondition,
    StyleCondition,
    ReferenceCondition,
    ReferencePathCondition,
    ParentPathCondition,
    ParentCondition,
    ChildCondition,
    ChildPathCondition,
    FlagCondition,
    PageCondition,
    LogicType,
    ScopeType,
    PropertyType,
)


class QueryASTToSQL:
    """Converts QueryAST to PostgreSQL queries."""
    
    def __init__(self, workspace_id: int, current_node_uuid: Optional[str] = None):
        """
        Initialize the SQL generator.
        
        Args:
            workspace_id: The workspace ID to query within
            current_node_uuid: UUID of the current node (for placeholder substitution)
        """
        self.workspace_id = workspace_id
        self.current_node_uuid = current_node_uuid
        self.params: Dict[str, Any] = {'workspace_id': workspace_id}
        # Note: current_uuid is added to params only when actually used in SQL
        self.param_counter = 0
    
    def generate(self, ast: QueryAST) -> Tuple[str, Dict[str, Any]]:
        """
        Generate SQL query from AST.
        
        Returns:
            (sql, params) tuple
        """
        # Base SELECT with all node fields plus page info for grouping
        sql_parts = [
            "SELECT DISTINCT n.*,",
            "       page.name AS page_name,",
            "       page.uuid AS page_uuid",
            "FROM node n",
            "LEFT JOIN node page ON page.id = n.page_id AND page.active = TRUE",
        ]
        
        # Generate WHERE clause from scope and conditions
        where_clauses = []
        
        # Always filter by workspace_id, active, not deleted, and exclude aliases
        where_clauses.append("n.workspace_id = %(workspace_id)s")
        where_clauses.append("n.active = TRUE")
        where_clauses.append("(n.is_deleted = FALSE OR n.is_deleted IS NULL)")
        where_clauses.append("n.aliased_id IS NULL")
        
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
        
        # Default ordering - use sequence for proper hierarchical ordering
        # This ensures children appear in their display order, not creation order
        sql_parts.append("ORDER BY n.sequence ASC, n.id ASC")
        
        # Combine into final SQL
        sql = "\n".join(sql_parts)
        
        return sql, self.params
    
    def _generate_scope_sql(self, scope: ScopeNode) -> Optional[str]:
        """Generate SQL for scope filtering."""
        if scope.scope_type == ScopeType.ENTIRE_WORKSPACE:
            # No additional filtering needed
            return None
        
        elif scope.scope_type == ScopeType.PAGES:
            # Only pages (is_page = true)
            return "n.is_page = TRUE"
        
        elif scope.scope_type == ScopeType.CURRENT_PAGE:
            if not self.current_node_uuid:
                return None
            
            # Add current_uuid to params when actually used
            self.params['current_uuid'] = self.current_node_uuid
            
            # Filter to current page or its descendants
            if scope.include_descendants:
                # Get all nodes under current page
                return f"(n.page_id = (SELECT id FROM node WHERE uuid = %(current_uuid)s::uuid AND workspace_id = %(workspace_id)s))"
            else:
                # Only the current page itself
                return f"(n.uuid = %(current_uuid)s::uuid)"
        
        elif scope.scope_type == ScopeType.SPECIFIC_PAGES:
            if not scope.page_uuids:
                return None
            
            # Filter to specific pages
            param_name = self._add_param(scope.page_uuids)
            
            if scope.include_descendants:
                # Pages and their descendants
                return f"(n.page_id IN (SELECT id FROM node WHERE uuid = ANY(%({param_name})s) AND workspace_id = %(workspace_id)s))"
            else:
                # Only the pages themselves
                return f"(n.uuid = ANY(%({param_name})s))"
        
        elif scope.scope_type == ScopeType.LINKED_REFS:
            if not self.current_node_uuid:
                return None
            
            # Add current_uuid to params when actually used
            self.params['current_uuid'] = self.current_node_uuid
            
            # Nodes that link to current node
            return """(n.id IN (
                SELECT source_id FROM node_link
                WHERE target_id = (SELECT id FROM node WHERE uuid = %(current_uuid)s::uuid AND workspace_id = %(workspace_id)s)
                AND workspace_id = %(workspace_id)s
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
        if isinstance(condition, ClassCondition):
            return self._generate_class_condition(condition)
        elif isinstance(condition, ExtendsCondition):
            return self._generate_extends_condition(condition)
        elif isinstance(condition, PropertyCondition):
            return self._generate_property_condition(condition)
        elif isinstance(condition, ContentCondition):
            return self._generate_content_condition(condition)
        elif isinstance(condition, StyleCondition):
            return self._generate_style_condition(condition)
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
        elif isinstance(condition, ChildCondition):
            return self._generate_child_condition(condition)
        elif isinstance(condition, ChildPathCondition):
            return self._generate_child_path_condition(condition)
        elif isinstance(condition, PageCondition):
            return self._generate_page_condition(condition)
        
        return None
    
    def _generate_class_condition(self, condition: ClassCondition) -> Optional[str]:
        """Generate SQL for class condition.
        
        Uses the class_ids array column in the node table to find nodes with a specific class.
        Also includes nodes whose classes extend the target class (inheritance).
        Similar to ParentCondition, supports {current_node_uuid} placeholder.
        """
        from app.logging_config import get_logger
        logger = get_logger(__name__)
        
        if not condition.class_uuid:
            return None
        
        # Skip if class_uuid is empty string (failed placeholder resolution)
        if condition.class_uuid.strip() == '':
            logger.warning("Class condition has empty class_uuid after placeholder resolution")
            return None
        
        # Check for unresolved placeholder
        if '{' in condition.class_uuid and '}' in condition.class_uuid:
            logger.error(f"Unresolved placeholder in class_uuid: {condition.class_uuid}")
            return None
        
        param_name = self._add_param(condition.class_uuid)
        logger.debug(f"Generating class condition SQL with uuid={condition.class_uuid}, operator={condition.operator}")
        
        # Recursive CTE: the target class and all classes that extend it (inheritance)
        class_hierarchy_cte = f"""WITH RECURSIVE class_hierarchy AS (
                        SELECT id FROM node WHERE uuid = %({param_name})s::uuid AND workspace_id = %(workspace_id)s
                        UNION
                        SELECT ce.target_id
                        FROM class_extend ce
                        INNER JOIN class_hierarchy ch ON ce.source_id = ch.id
                    )"""
        
        operator = condition.operator or 'contains'
        
        if operator == 'does_not_contain':
            # Node does NOT have this class (or any subclass) in its class_ids array
            return f"""(
            NOT EXISTS (
                SELECT 1 FROM (
                    {class_hierarchy_cte}
                    SELECT id FROM class_hierarchy
                ) AS matching_classes
                WHERE matching_classes.id = ANY(n.class_ids)
            )
        )"""
        elif operator == 'defined':
            return "n.class_ids IS NOT NULL AND array_length(n.class_ids, 1) > 0"
        elif operator == 'not_defined':
            return "(n.class_ids IS NULL OR array_length(n.class_ids, 1) = 0)"
        else:
            # Default: 'contains' / 'is' — node has this class (or a subclass)
            return f"""(
            EXISTS (
                SELECT 1 FROM (
                    {class_hierarchy_cte}
                    SELECT id FROM class_hierarchy
                ) AS matching_classes
                WHERE matching_classes.id = ANY(n.class_ids)
            )
        )"""
    
    def _generate_extends_condition(self, condition: ExtendsCondition) -> Optional[str]:
        """Generate SQL for extends condition.
        
        Finds classes (nodes) that extend a given class.
        Used for "Extended By" sections to show child classes.
        """
        from app.logging_config import get_logger
        logger = get_logger(__name__)
        
        if not condition.extends_class_uuid:
            return None
        
        # Skip if extends_class_uuid is empty string (failed placeholder resolution)
        if condition.extends_class_uuid.strip() == '':
            logger.warning("Extends condition has empty extends_class_uuid after placeholder resolution")
            return None
        
        # Check for unresolved placeholder
        if '{' in condition.extends_class_uuid and '}' in condition.extends_class_uuid:
            logger.error(f"Unresolved placeholder in extends_class_uuid: {condition.extends_class_uuid}")
            return None
        
        param_name = self._add_param(condition.extends_class_uuid)
        logger.debug(f"Generating extends condition SQL with uuid={condition.extends_class_uuid}")
        
        # Query classes that extend the target class via the class_extend table
        # target_id = the class that extends (child), source_id = the class being extended (parent)
        return f"""(
            n.id IN (
                SELECT ce.target_id
                FROM class_extend ce
                INNER JOIN node parent_class ON parent_class.id = ce.source_id
                WHERE parent_class.uuid = %({param_name})s::uuid
                  AND parent_class.workspace_id = %(workspace_id)s
            )
        )"""
    
    def _generate_property_condition(self, condition: PropertyCondition) -> Optional[str]:
        """Generate SQL for property condition.
        
        Handles both:
        - Built-in node columns (uuid, name, id, etc.)
        - Custom properties stored in property_value_* tables
        """
        if not condition.property_name:
            return None
        
        # Built-in node columns that should be queried directly
        BUILTIN_COLUMNS = {'uuid', 'name', 'id', 'parent_id', 'is_page', 'is_favorite', 'page_uuid'}
        
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
            
            # Special handling for page_uuid - filters by the uuid of the containing page
            # Uses the LEFT JOINed 'page' alias (page ON page.id = n.page_id)
            # NULL page_id means the node IS a page (no container), so keep it when excluding a page
            if column_name == 'page_uuid':
                if condition.operator == 'equals':
                    return f"(n.page_id IS NOT NULL AND page.uuid::text = %({value_param})s)"
                elif condition.operator == 'not_equals':
                    return f"(n.page_id IS NULL OR page.uuid::text != %({value_param})s)"
            
            # Special handling for name column - extract text from JSON AST
            if column_name == 'name':
                text_expr = self._name_text_expr()
                if condition.operator == 'equals':
                    return f"{text_expr} = %({value_param})s"
                elif condition.operator == 'not_equals':
                    return f"{text_expr} != %({value_param})s"
                elif condition.operator == 'contains':
                    return f"{text_expr} ILIKE '%%' || %({value_param})s || '%%'"
                return None
            
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
        
        # Custom property - query by UUID only
        else:
            if not condition.property_uuid:
                logger.warning(f"Property condition missing UUID, skipping (name={condition.property_name!r})")
                return None
            prop_param = self._add_param(condition.property_uuid)
            prop_join_clause = f"JOIN property p ON p.id = np.property_id AND p.uuid = %({prop_param})s::uuid"
            
            if condition.operator == 'is_empty':
                return f"""NOT EXISTS (
                    SELECT 1 FROM node_property np
                    {prop_join_clause}
                    WHERE np.node_id = n.id
                )"""
            
            elif condition.operator == 'is_not_empty':
                return f"""EXISTS (
                    SELECT 1 FROM node_property np
                    {prop_join_clause}
                    WHERE np.node_id = n.id
                )"""
            
            # For value-based operators
            if condition.value is None:
                return None
            
            value_param = self._add_param(condition.value)
            
            # Selection type queries property_value_selection + property_selection_line
            if condition.property_type == PropertyType.SELECTION:
                if condition.operator == 'equals':
                    return f"""EXISTS (
                        SELECT 1 FROM node_property np
                        {prop_join_clause}
                        JOIN property_value_selection pvsel ON pvsel.node_property_id = np.id
                        JOIN property_selection_line psl ON psl.id = pvsel.selection_line_id
                        WHERE np.node_id = n.id
                        AND psl.name = %({value_param})s
                    )"""
                
                elif condition.operator == 'not_equals':
                    return f"""NOT EXISTS (
                        SELECT 1 FROM node_property np
                        {prop_join_clause}
                        JOIN property_value_selection pvsel ON pvsel.node_property_id = np.id
                        JOIN property_selection_line psl ON psl.id = pvsel.selection_line_id
                        WHERE np.node_id = n.id
                        AND psl.name = %({value_param})s
                    )"""
                
                elif condition.operator == 'contains':
                    return f"""EXISTS (
                        SELECT 1 FROM node_property np
                        {prop_join_clause}
                        JOIN property_value_selection pvsel ON pvsel.node_property_id = np.id
                        JOIN property_selection_line psl ON psl.id = pvsel.selection_line_id
                        WHERE np.node_id = n.id
                        AND psl.name ILIKE '%%' || %({value_param})s || '%%'
                    )"""
                
                return None
            
            if condition.operator == 'equals':
                # Check in property_value_scalar table
                return f"""EXISTS (
                    SELECT 1 FROM node_property np
                    {prop_join_clause}
                    JOIN property_value_scalar pvs ON pvs.node_property_id = np.id
                    WHERE np.node_id = n.id 
                    AND pvs.value_text = %({value_param})s
                )"""
            
            elif condition.operator == 'not_equals':
                return f"""NOT EXISTS (
                    SELECT 1 FROM node_property np
                    {prop_join_clause}
                    JOIN property_value_scalar pvs ON pvs.node_property_id = np.id
                    WHERE np.node_id = n.id 
                    AND pvs.value_text = %({value_param})s
                )"""
            
            elif condition.operator == 'contains':
                return f"""EXISTS (
                    SELECT 1 FROM node_property np
                    {prop_join_clause}
                    JOIN property_value_scalar pvs ON pvs.node_property_id = np.id
                    WHERE np.node_id = n.id 
                    AND pvs.value_text ILIKE '%%' || %({value_param})s || '%%'
                )"""
            
            elif condition.operator == 'greater_than':
                return f"""EXISTS (
                    SELECT 1 FROM node_property np
                    {prop_join_clause}
                    JOIN property_value_scalar pvs ON pvs.node_property_id = np.id
                    WHERE np.node_id = n.id 
                    AND pvs.value_float > %({value_param})s::numeric
                )"""
            
            elif condition.operator == 'less_than':
                return f"""EXISTS (
                    SELECT 1 FROM node_property np
                    {prop_join_clause}
                    JOIN property_value_scalar pvs ON pvs.node_property_id = np.id
                    WHERE np.node_id = n.id 
                    AND pvs.value_float < %({value_param})s::numeric
                )"""
        
        return None
    
    def _name_text_expr(self) -> str:
        """SQL expression that extracts plain text from n.name.
        
        Handles both:
        - JSON AST (starts with '[') → recursively extracts all 'text' field values
        - Plain text → returns as-is
        
        Uses PostgreSQL jsonb_path_query for recursive text extraction.
        """
        return """(CASE
            WHEN n.name IS NOT NULL AND n.name LIKE '[%' THEN
                COALESCE((SELECT string_agg(t #>> '{}', '') FROM jsonb_path_query(n.name::jsonb, '$.**.text') AS t), '')
            ELSE COALESCE(n.name, '')
        END)"""
    
    def _generate_content_condition(self, condition: ContentCondition) -> Optional[str]:
        """Generate SQL for content/name search condition.
        
        Extracts plain text from JSON AST before matching, so searches
        work on readable text rather than raw JSON strings.
        """
        if not condition.value:
            return None
        
        value_param = self._add_param(condition.value)
        text_expr = self._name_text_expr()
        
        if condition.operator == 'contains':
            if condition.case_sensitive:
                return f"{text_expr} LIKE '%%' || %({value_param})s || '%%'"
            else:
                return f"{text_expr} ILIKE '%%' || %({value_param})s || '%%'"
        
        elif condition.operator == 'starts_with':
            if condition.case_sensitive:
                return f"{text_expr} LIKE %({value_param})s || '%%'"
            else:
                return f"{text_expr} ILIKE %({value_param})s || '%%'"
        
        elif condition.operator == 'ends_with':
            if condition.case_sensitive:
                return f"{text_expr} LIKE '%%' || %({value_param})s"
            else:
                return f"{text_expr} ILIKE '%%' || %({value_param})s"
        
        elif condition.operator == 'equals':
            if condition.case_sensitive:
                return f"{text_expr} = %({value_param})s"
            else:
                return f"LOWER({text_expr}) = LOWER(%({value_param})s)"
        
        elif condition.operator == 'regex':
            return f"{text_expr} ~ %({value_param})s"
        
        return None
    
    def _generate_style_condition(self, condition: StyleCondition) -> Optional[str]:
        """Generate SQL for style/formatting condition.
        
        Checks whether node content (JSON AST in n.name) contains specific
        formatting types (strong, em, underline, strikethrough).
        
        Uses PostgreSQL jsonb_path_exists for recursive type matching.
        
        Operators:
        - contains: at least one node of the given mark type exists
        - does_not_contain: no node of the given mark type exists
        - is: ALL direct children of paragraphs are of the given mark type (entire content is styled)
        - is_not: NOT all content is styled with this type
        """
        # Map style_type to AST node type name
        STYLE_TO_AST_TYPE = {
            'bold': 'strong',
            'italic': 'em',
            'underline': 'underline',
            'strikethrough': 'strikethrough',
        }
        
        ast_type = STYLE_TO_AST_TYPE.get(condition.style_type.value if hasattr(condition.style_type, 'value') else condition.style_type)
        if not ast_type:
            return None
        
        # Guard: only check nodes with JSON AST content (starts with '[')
        json_guard = "n.name IS NOT NULL AND n.name LIKE '[%%'"
        
        # jsonpath expression to check for the mark type at any depth
        # Safe to interpolate ast_type since it comes from a fixed map
        has_type_expr = f"""jsonb_path_exists(n.name::jsonb, '$.**.type ? (@ == "{ast_type}")')"""
        
        op = condition.operator.value if hasattr(condition.operator, 'value') else condition.operator
        
        if op == 'contains':
            return f"({json_guard} AND {has_type_expr})"
        
        elif op == 'does_not_contain':
            return f"(NOT ({json_guard} AND {has_type_expr}))"
        
        elif op == 'is':
            # All direct children of all paragraphs must be of this type
            # AND at least one such node must exist
            all_styled = f"""NOT EXISTS (
                SELECT 1 FROM jsonb_array_elements(n.name::jsonb) AS block,
                LATERAL jsonb_array_elements(block -> 'children') AS child
                WHERE child ->> 'type' != '{ast_type}'
            )"""
            return f"({json_guard} AND {has_type_expr} AND {all_styled})"
        
        elif op == 'is_not':
            # Not entirely styled: either no AST, or has non-styled children, or no styled content
            all_styled = f"""NOT EXISTS (
                SELECT 1 FROM jsonb_array_elements(n.name::jsonb) AS block,
                LATERAL jsonb_array_elements(block -> 'children') AS child
                WHERE child ->> 'type' != '{ast_type}'
            )"""
            return f"(NOT ({json_guard} AND {has_type_expr} AND {all_styled}))"
        
        return None
    
    def _generate_reference_condition(self, condition: ReferenceCondition) -> Optional[str]:
        """Generate SQL for reference condition.
        
        Includes both text-based links (node_link) and property-based links (property_value_relation).
        """
        if not condition.target_uuid:
            return None
        
        param_name = self._add_param(condition.target_uuid)
        param_name2 = self._add_param(condition.target_uuid)
        
        # Check if node has a link to target via node_link OR property_value_relation
        return f"""(EXISTS (
            SELECT 1 FROM node_link
            WHERE source_id = n.id
            AND target_id = (SELECT id FROM node WHERE uuid = %({param_name})s AND workspace_id = %(workspace_id)s)
            AND workspace_id = %(workspace_id)s
        ) OR EXISTS (
            SELECT 1 FROM property_value_relation pvr
            WHERE pvr.node_id = n.id
            AND pvr.target_id = (SELECT id FROM node WHERE uuid = %({param_name2})s AND workspace_id = %(workspace_id)s)
        ))"""
    
    def _generate_reference_path_condition(self, condition: ReferencePathCondition) -> Optional[str]:
        """Generate SQL for reference path condition.
        
        A node N matches reference_path to target T if:
        - N or any ancestor of N references T (via node_link or property_value_relation)
        - OR T is an ancestor of N (N is inside T's hierarchy)
        
        This uses the node_path closure table (which includes self at depth=0)
        so the node's own direct references are also captured.
        """
        # Static mode: target_uuids specified directly
        if condition.target_uuids:
            uuid_list = [u for u in condition.target_uuids if u]
            if not uuid_list:
                return None
            
            param_name = self._add_param(uuid_list)
            target_subquery = f"(SELECT id FROM node WHERE uuid = ANY(%({param_name})s) AND workspace_id = %(workspace_id)s)"
            
            return f"""(
                EXISTS (
                    SELECT 1 FROM node_path np
                    JOIN node_link nl ON nl.source_id = np.ancestor_id
                    WHERE np.descendant_id = n.id
                    AND nl.target_id IN {target_subquery}
                    AND nl.workspace_id = %(workspace_id)s
                )
                OR EXISTS (
                    SELECT 1 FROM node_path np
                    JOIN property_value_relation pvr ON pvr.node_id = np.ancestor_id
                    WHERE np.descendant_id = n.id
                    AND pvr.target_id IN {target_subquery}
                )
                OR EXISTS (
                    SELECT 1 FROM node_path np
                    WHERE np.descendant_id = n.id
                    AND np.ancestor_id IN {target_subquery}
                    AND np.depth > 0
                )
            )"""
        
        # Dynamic mode: nested_group with conditions
        if condition.nested_group and condition.nested_group.children:
            # Handle UUID block (most common case - e.g., {current_node_uuid})
            first_block = condition.nested_group.children[0]
            if hasattr(first_block, 'value'):
                uuid_value = first_block.value
                param_name = self._add_param(uuid_value)
                param_name2 = self._add_param(uuid_value)
                param_name3 = self._add_param(uuid_value)
                target_subquery = f"(SELECT id FROM node WHERE uuid = %({param_name})s AND workspace_id = %(workspace_id)s)"
                target_subquery2 = f"(SELECT id FROM node WHERE uuid = %({param_name2})s AND workspace_id = %(workspace_id)s)"
                target_subquery3 = f"(SELECT id FROM node WHERE uuid = %({param_name3})s AND workspace_id = %(workspace_id)s)"
                
                return f"""(
                    EXISTS (
                        SELECT 1 FROM node_path np
                        JOIN node_link nl ON nl.source_id = np.ancestor_id
                        WHERE np.descendant_id = n.id
                        AND nl.target_id = {target_subquery}
                        AND nl.workspace_id = %(workspace_id)s
                    )
                    OR EXISTS (
                        SELECT 1 FROM node_path np
                        JOIN property_value_relation pvr ON pvr.node_id = np.ancestor_id
                        WHERE np.descendant_id = n.id
                        AND pvr.target_id = {target_subquery2}
                    )
                    OR EXISTS (
                        SELECT 1 FROM node_path np
                        WHERE np.descendant_id = n.id
                        AND np.ancestor_id = {target_subquery3}
                        AND np.depth > 0
                    )
                )"""
        
        return None
    
    def _generate_parent_path_condition(self, condition: ParentPathCondition) -> Optional[str]:
        """Generate SQL for parent path condition.
        
        This finds nodes that are descendants of nodes matching the nested group.
        For child_pages view: finds direct children (max_depth=1) of the current node.
        
        Operators:
        - has_ancestor: node is descendant of matching nodes
        - not_has_ancestor: node is NOT descendant of matching nodes
        - has_no_ancestor: node has no ancestors (root nodes)
        - has_any_ancestor: node has any ancestor (not root)
        """
        operator = getattr(condition, 'operator', 'has_ancestor')
        
        # Handle no-value operators
        if operator == 'has_no_ancestor':
            # Node is a root (no ancestors in node_path)
            return "NOT EXISTS (SELECT 1 FROM node_path np WHERE np.descendant_id = n.id)"
        elif operator == 'has_any_ancestor':
            # Node has at least one ancestor
            return "EXISTS (SELECT 1 FROM node_path np WHERE np.descendant_id = n.id)"
        
        if not condition.nested_group or not condition.nested_group.blocks:
            return None
        
        # Get the first block in the group - typically a UUID block
        first_block = condition.nested_group.blocks[0]
        
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
            
            if operator == 'not_has_ancestor':
                return f"""(NOT EXISTS (
                    SELECT 1 FROM node_path np
                    WHERE np.descendant_id = n.id
                    AND np.ancestor_id = (SELECT id FROM node WHERE uuid = %({param_name})s AND workspace_id = %(workspace_id)s)
                    {depth_condition}
                ))"""
            else:  # has_ancestor (default)
                return f"""(EXISTS (
                    SELECT 1 FROM node_path np
                    WHERE np.descendant_id = n.id
                    AND np.ancestor_id = (SELECT id FROM node WHERE uuid = %({param_name})s AND workspace_id = %(workspace_id)s)
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
        
        Operators:
        - has_parent: parent is specific node(s)
        - not_has_parent: parent is NOT specific node(s)
        - has_no_parent: node has no parent (root node)
        - has_any_parent: node has any parent (not root)
        """
        from app.logging_config import get_logger
        logger = get_logger(__name__)
        
        # Handle operator - default to 'has_parent' if not specified
        operator = getattr(condition, 'operator', 'has_parent')
        
        # Static mode: direct parent UUID(s)/ID(s)
        parent_uuids = None
        if condition.parent_uuids:
            parent_uuids = condition.parent_uuids
        elif condition.parent_uuid:
            parent_uuids = [condition.parent_uuid]
        
        if parent_uuids:
            # Filter out empty strings and unresolved placeholders
            valid_uuids = []
            for uuid in parent_uuids:
                if not uuid or uuid.strip() == '':
                    logger.warning("Parent condition has empty parent_uuid after placeholder resolution")
                    continue
                if '{' in uuid and '}' in uuid:
                    logger.error(f"Unresolved placeholder in parent_uuid: {uuid}")
                    continue
                valid_uuids.append(uuid)
            
            if not valid_uuids:
                return None
            
            # Add all UUIDs as parameters
            param_names = [self._add_param(uuid) for uuid in valid_uuids]
            param_refs = ', '.join([f'%({p})s' for p in param_names])
            logger.debug(f"Generating parent condition SQL with uuids={valid_uuids}, operator={operator}")
            
            if operator == 'not_has_parent':
                # Parent is NOT one of the specified nodes
                return f"n.parent_id NOT IN (SELECT id FROM node WHERE uuid IN ({param_refs}) AND workspace_id = %(workspace_id)s)"
            elif operator == 'has_no_parent':
                # Ignore the specified parents and just check for NULL
                return "n.parent_id IS NULL"
            elif operator == 'has_any_parent':
                # Ignore the specified parents and just check for NOT NULL
                return "n.parent_id IS NOT NULL"
            else:  # has_parent (default)
                # Parent is one of the specified nodes
                return f"n.parent_id IN (SELECT id FROM node WHERE uuid IN ({param_refs}) AND workspace_id = %(workspace_id)s)"
        
        # Dynamic mode: nested group filters
        if not condition.nested_group:
            # If no parent_uuid and no nested_group, handle based on operator
            if operator == 'has_no_parent':
                return "n.parent_id IS NULL"
            elif operator == 'has_any_parent':
                return "n.parent_id IS NOT NULL"
            # For has_parent/not_has_parent without specification, this is invalid - return None
            return None
        
        # Generate SQL for the nested group that filters parent nodes
        nested_sql = self._generate_group_sql(condition.nested_group)
        if not nested_sql:
            return None
        
        # Replace all references to 'n.' in nested SQL with 'parent_n.' to refer to parent node
        # Need to handle various patterns: " n.", "(n.", "=n.", etc.
        import re
        parent_sql = re.sub(r'\bn\.', 'parent_n.', nested_sql)
        
        if operator == 'not_has_parent':
            # Negate: node's parent must NOT match the criteria
            return f"""n.parent_id NOT IN (
                SELECT parent_n.id FROM node parent_n
                WHERE parent_n.workspace_id = %(workspace_id)s AND parent_n.active = TRUE
                AND ({parent_sql})
            )"""
        elif operator == 'has_no_parent':
            # Node has no parent at all
            return "n.parent_id IS NULL"
        elif operator == 'has_any_parent':
            # Node has any parent
            return "n.parent_id IS NOT NULL"
        else:  # has_parent (default)
            return f"""n.parent_id IN (
                SELECT parent_n.id FROM node parent_n
                WHERE parent_n.workspace_id = %(workspace_id)s AND parent_n.active = TRUE
                AND ({parent_sql})
            )"""

    def _generate_page_condition(self, condition: PageCondition) -> Optional[str]:
        """Generate SQL for page condition - filter by containing page (page_id).
        
        Operators:
        - is_page: node's containing page matches
        - is_not_page: node's containing page does NOT match
        - has_no_page: node has no page (i.e., IS a page itself)
        - has_any_page: node has a page (i.e., is a block)
        """
        operator = getattr(condition, 'operator', 'is_page')

        # Static mode: specific page UUID(s)
        if condition.page_uuids or condition.page_uuid:
            page_uuids = condition.page_uuids or ([condition.page_uuid] if condition.page_uuid else [])

            # Resolve {current_node_uuid} placeholder
            resolved = []
            for uuid in page_uuids:
                if uuid == '{current_node_uuid}' and self.current_node_uuid:
                    resolved.append(self.current_node_uuid)
                else:
                    resolved.append(uuid)

            param_names = [self._add_param(uuid) for uuid in resolved]
            param_refs = ', '.join([f'%({p})s' for p in param_names])

            if operator == 'is_not_page':
                return f"(n.page_id IS NULL OR n.page_id NOT IN (SELECT id FROM node WHERE uuid IN ({param_refs}) AND workspace_id = %(workspace_id)s AND active = TRUE))"
            else:  # is_page (default)
                return f"n.page_id IN (SELECT id FROM node WHERE uuid IN ({param_refs}) AND workspace_id = %(workspace_id)s AND active = TRUE)"

        # No static value and no nested group
        if not condition.nested_group:
            if operator == 'has_no_page':
                return "n.page_id IS NULL"
            elif operator == 'has_any_page':
                return "n.page_id IS NOT NULL"
            return None

        # Dynamic mode: page matching criteria via nested group
        nested_sql = self._generate_group_sql(condition.nested_group)
        if not nested_sql:
            return None

        import re
        page_sql = re.sub(r'\bn\.', 'page_n.', nested_sql)

        if operator == 'is_not_page':
            return f"""(n.page_id IS NULL OR n.page_id NOT IN (
                SELECT page_n.id FROM node page_n
                WHERE page_n.workspace_id = %(workspace_id)s AND page_n.active = TRUE
                AND ({page_sql})
            ))"""
        elif operator == 'has_no_page':
            return "n.page_id IS NULL"
        elif operator == 'has_any_page':
            return "n.page_id IS NOT NULL"
        else:  # is_page (default)
            return f"""n.page_id IN (
                SELECT page_n.id FROM node page_n
                WHERE page_n.workspace_id = %(workspace_id)s AND page_n.active = TRUE
                AND ({page_sql})
            )"""

    def _generate_child_condition(self, condition: ChildCondition) -> Optional[str]:
        """Generate SQL for child condition - direct children match.
        
        Operators:
        - has_child: node has a child matching criteria
        - not_has_child: node has no child matching criteria
        - has_no_child: node has no children at all
        - has_any_child: node has at least one child
        """
        operator = getattr(condition, 'operator', 'has_child')
        
        # Handle no-value operators
        if operator == 'has_no_child':
            # Node has no children
            return "NOT EXISTS (SELECT 1 FROM node child_n WHERE child_n.parent_id = n.id AND child_n.workspace_id = %(workspace_id)s AND child_n.active = TRUE)"
        elif operator == 'has_any_child':
            # Node has at least one child
            return "EXISTS (SELECT 1 FROM node child_n WHERE child_n.parent_id = n.id AND child_n.workspace_id = %(workspace_id)s AND child_n.active = TRUE)"
        
        # Static mode: specific child UUID(s)
        if condition.child_uuids:
            child_uuids = condition.child_uuids
            
            # Add all UUIDs as parameters
            param_names = [self._add_param(uuid) for uuid in child_uuids]
            param_refs = ', '.join([f'%({p})s' for p in param_names])
            
            if operator == 'not_has_child':
                # Node does NOT have any of these specific children
                return f"""NOT EXISTS (
                    SELECT 1 FROM node child_n
                    WHERE child_n.parent_id = n.id
                    AND child_n.uuid IN ({param_refs})
                    AND child_n.workspace_id = %(workspace_id)s
                    AND child_n.active = TRUE
                )"""
            else:  # has_child (default)
                # Node has at least one of these specific children
                return f"""EXISTS (
                    SELECT 1 FROM node child_n
                    WHERE child_n.parent_id = n.id
                    AND child_n.uuid IN ({param_refs})
                    AND child_n.workspace_id = %(workspace_id)s
                    AND child_n.active = TRUE
                )"""
        
        # Dynamic mode: children matching criteria
        if not condition.nested_group:
            return None
        
        # Generate SQL for the nested group that filters child nodes
        nested_sql = self._generate_group_sql(condition.nested_group)
        if not nested_sql:
            return None
        
        # Replace all references to 'n.' in nested SQL with 'child_n.' to refer to child node
        import re
        child_sql = re.sub(r'\bn\.', 'child_n.', nested_sql)
        
        if operator == 'not_has_child':
            # Node has no children matching criteria
            return f"""NOT EXISTS (
                SELECT 1 FROM node child_n
                WHERE child_n.parent_id = n.id
                AND child_n.workspace_id = %(workspace_id)s
                AND child_n.active = TRUE
                AND ({child_sql})
            )"""
        else:  # has_child (default)
            return f"""EXISTS (
                SELECT 1 FROM node child_n
                WHERE child_n.parent_id = n.id
                AND child_n.workspace_id = %(workspace_id)s
                AND child_n.active = TRUE
                AND ({child_sql})
            )"""
    
    def _generate_child_path_condition(self, condition: ChildPathCondition) -> Optional[str]:
        """Generate SQL for child path condition - descendants match.
        
        Operators:
        - has_descendant: node has a descendant matching criteria
        - not_has_descendant: node has no descendant matching criteria
        - has_no_descendant: node has no descendants at all
        - has_any_descendant: node has at least one descendant
        """
        operator = getattr(condition, 'operator', 'has_descendant')
        
        # Handle no-value operators
        if operator == 'has_no_descendant':
            # Node has no descendants (no entries in node_path where it's the ancestor)
            return "NOT EXISTS (SELECT 1 FROM node_path np WHERE np.ancestor_id = n.id)"
        elif operator == 'has_any_descendant':
            # Node has at least one descendant
            return "EXISTS (SELECT 1 FROM node_path np WHERE np.ancestor_id = n.id)"
        
        if not condition.nested_group or not condition.nested_group.blocks:
            return None
        
        # Get the first block in the group
        first_block = condition.nested_group.blocks[0]
        
        # Handle UUID block (for specific node matching)
        if hasattr(first_block, 'value'):
            uuid_value = first_block.value
            param_name = self._add_param(uuid_value)
            
            # Build depth condition
            depth_condition = ""
            if condition.max_depth is not None:
                depth_param = self._add_param(condition.max_depth)
                depth_condition = f" AND np.depth = %({depth_param})s"
            
            if operator == 'not_has_descendant':
                return f"""NOT EXISTS (
                    SELECT 1 FROM node_path np
                    WHERE np.ancestor_id = n.id
                    AND np.descendant_id = (SELECT id FROM node WHERE uuid = %({param_name})s AND workspace_id = %(workspace_id)s)
                    {depth_condition}
                )"""
            else:  # has_descendant (default)
                return f"""EXISTS (
                    SELECT 1 FROM node_path np
                    WHERE np.ancestor_id = n.id
                    AND np.descendant_id = (SELECT id FROM node WHERE uuid = %({param_name})s AND workspace_id = %(workspace_id)s)
                    {depth_condition}
                )"""
        
        return None
    
    def _add_param(self, value: Any) -> str:
        """Add a parameter and return its name."""
        param_name = f'p{self.param_counter}'
        self.params[param_name] = value
        self.param_counter += 1
        return param_name


def generate_sql_from_ast(
    ast: QueryAST,
    workspace_id: int,
    current_node_uuid: Optional[str] = None
) -> Tuple[str, Dict[str, Any]]:
    """
    Generate SQL query from QueryAST.
    
    Args:
        ast: The QueryAST to convert
        workspace_id: The workspace ID to query within
        current_node_uuid: UUID of current node for placeholder substitution
    
    Returns:
        (sql, params) tuple
    """
    generator = QueryASTToSQL(workspace_id, current_node_uuid)
    return generator.generate(ast)
