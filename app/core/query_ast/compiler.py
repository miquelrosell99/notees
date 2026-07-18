"""QueryAST to SQLite SQL compiler.

Targets the derived SQLite schema produced by ``app.core.migration.replay``.
Uses positional ``?`` placeholders.
"""

from __future__ import annotations

import logging
from typing import Any

from app.domain.entities.query_ast import (
    AggregateFunction,
    AggregationDimension,
    AggregationMeasure,
    ChildCondition,
    ChildPathCondition,
    ClassCondition,
    ConditionNode,
    ContentCondition,
    ContentOperator,
    ExtendsCondition,
    FlagCondition,
    GroupNode,
    LogicType,
    NotNode,
    PageCondition,
    ParentCondition,
    ParentPathCondition,
    PropertyCondition,
    PropertyOperator,
    PropertyType,
    QueryAST,
    ReferenceCondition,
    ReferencePathCondition,
    ScopeNode,
    ScopeType,
    StyleCondition,
    StyleOperator,
    StyleType,
    TagCondition,
)
from app.domain.errors import DomainError

logger = logging.getLogger(__name__)

# Built-in node columns that map directly to the derived ``node`` table.
BUILTIN_COLUMNS = {
    "uuid": "n.id",
    "name": "COALESCE((SELECT content FROM search_index si WHERE si.node_id = n.id), '')",
    "parent_id": "n.parent_id",
    "create_date": "DATE(n.created_at)",
    "write_date": "DATE(n.updated_at)",
    "page_uuid": "pa.page_id",
    "kind": "n.kind",
}

# Flags that can be mapped to the derived schema.
MAPPABLE_FLAGS = {
    "is_page": "n.kind = 'page'",
    "is_class": "n.kind = 'class'",
}

# Mapping from UI style names to AST node types.
STYLE_TO_AST_TYPE = {
    "bold": "strong",
    "italic": "em",
    "underline": "underline",
    "strikethrough": "strikethrough",
    "broken_link": "broken_link",
}


class QueryASTToSQLite:
    """Compile a :class:`QueryAST` into SQLite SQL against the derived schema."""

    def __init__(self, workspace_id: str, current_node_uuid: str | None = None) -> None:
        self.workspace_id = workspace_id
        self.current_node_uuid = current_node_uuid
        self.params: list[Any] = []

    def generate(self, ast: QueryAST) -> tuple[str, list[Any]]:
        """Generate a normal SELECT query for the AST."""
        self.params = [self.workspace_id, self.workspace_id]

        sql_parts = [
            "WITH RECURSIVE page_ancestors AS (",
            "    SELECT id, parent_id, kind, id AS page_id, 0 AS depth",
            "    FROM node",
            "    WHERE workspace_id = ? AND kind = 'page'",
            "    UNION ALL",
            "    SELECT node.id, node.parent_id, node.kind, page_ancestors.page_id, page_ancestors.depth + 1",
            "    FROM node",
            "    JOIN page_ancestors ON node.parent_id = page_ancestors.id",
            "    WHERE node.workspace_id = ?",
            ")",
            "SELECT DISTINCT n.*, pa.page_id, pa.depth",
            "FROM node n",
            "LEFT JOIN page_ancestors pa ON pa.id = n.id",
        ]

        where_clauses: list[str] = ["n.workspace_id = ?"]
        self.params.append(self.workspace_id)

        scope_clause = self._generate_scope_sql(ast.scope)
        if scope_clause:
            where_clauses.append(scope_clause)

        if ast.root_group.children:
            group_clause = self._generate_group_sql(ast.root_group)
            if group_clause:
                where_clauses.append(f"({group_clause})")

        sql_parts.append("WHERE " + " AND ".join(where_clauses))
        sql_parts.append("ORDER BY n.id")

        return "\n".join(sql_parts), self.params

    def generate_aggregate(self, ast: QueryAST) -> tuple[str, list[Any]]:
        """Generate an aggregate query for the AST."""
        base_sql, base_params = self.generate(ast)
        base_sql = base_sql.rsplit("\nORDER BY", 1)[0]

        if not ast.aggregation:
            raise DomainError("Aggregation requested but AST has no aggregation node")

        aggregation = ast.aggregation
        dimensions = aggregation.dimensions or []
        if not dimensions and aggregation.group_by:
            dimensions = [
                AggregationDimension(
                    field=aggregation.group_by,
                    property_type=aggregation.group_by_property_type,
                )
            ]
        if not dimensions:
            raise DomainError("Aggregation has no dimensions")

        measure = aggregation.measure or AggregationMeasure()

        select_cols: list[str] = []
        group_exprs: list[str] = []
        join_clauses: list[str] = []

        for idx, dim in enumerate(dimensions):
            alias = f"dim_{idx}"
            expr = self._dimension_expr(dim, idx, join_clauses)
            select_cols.append(f"    {expr} AS {alias}")
            group_exprs.append(expr)

        measure_expr = self._measure_expr(measure, join_clauses)
        select_cols.append(f"    {measure_expr} AS value")

        joins_sql = "\n".join(join_clauses)
        select_sql = ",\n".join(select_cols)
        group_by_sql = ", ".join(group_exprs)
        order_by_sql = f"{group_exprs[0]} ASC, value DESC"

        sql = f"""WITH filtered_nodes AS (
{base_sql}
)
SELECT
{select_sql}
FROM filtered_nodes fn
{joins_sql}
GROUP BY {group_by_sql}
ORDER BY {order_by_sql}"""
        return sql, base_params

    def _dimension_expr(self, dim: AggregationDimension, idx: int, joins: list[str]) -> str:
        field = dim.field
        builtin_exprs = {
            "is_page": "CASE WHEN fn.kind = 'page' THEN 1 ELSE 0 END",
            "create_date": "DATE(fn.created_at)",
            "write_date": "DATE(fn.updated_at)",
            "page": "fn.page_id",
            "class": "fn.class_ids",
        }
        if field in builtin_exprs:
            return builtin_exprs[field]

        # Property dimension.
        if not dim.property_type:
            raise DomainError(f"Property dimension requires property_type for {field}")

        alias = f"pd_{idx}"
        joins.append(
            f"LEFT JOIN property_value {alias} ON {alias}.node_id = fn.id "
            f"AND {alias}.property_schema_id = {self._add_param(field)}"
        )
        prop_type = dim.property_type
        if prop_type == PropertyType.MULTI_SELECT.value:
            return f"COALESCE((SELECT group_concat(value, ',') FROM json_each(json_extract({alias}.value, '$.value'))), '(No value)')"
        if prop_type == PropertyType.NUMBER.value:
            return f"COALESCE(CAST(json_extract({alias}.value, '$.value') AS REAL), '(No value)')"
        return f"COALESCE(json_extract({alias}.value, '$.value'), '(No value)')"

    def _measure_expr(self, measure: AggregationMeasure, joins: list[str]) -> str:
        if measure.function == AggregateFunction.COUNT or not measure.field:
            return "COUNT(*)"

        if measure.field in ("sequence", "id"):
            raise DomainError(f"Builtin numeric measure '{measure.field}' is out of scope in SQLite derived schema")

        if not measure.property_type:
            raise DomainError(f"Property measure requires property_type for {measure.field}")

        joins.append(
            "LEFT JOIN property_value pm ON pm.node_id = fn.id "
            f"AND pm.property_schema_id = {self._add_param(measure.field)}"
        )
        return (
            f"{measure.function.upper()}(CAST(json_extract(pm.value, '$.value') AS REAL))"
        )

    def _generate_scope_sql(self, scope: ScopeNode) -> str | None:
        scope_type = scope.scope_type.value if isinstance(scope.scope_type, ScopeType) else scope.scope_type

        if scope_type == ScopeType.ENTIRE_WORKSPACE.value:
            return None

        if scope_type == ScopeType.PAGES.value:
            return "n.kind = 'page'"

        if scope_type == ScopeType.CURRENT_PAGE.value:
            if not self.current_node_uuid:
                return None
            if scope.include_descendants:
                self.params.append(self.current_node_uuid)
                return (
                    "pa.page_id = ("
                    "    SELECT pa2.page_id FROM page_ancestors pa2 "
                    "    WHERE pa2.id = ?"
                    ")"
                )
            self.params.append(self.current_node_uuid)
            return "n.id = ?"

        if scope_type == "specific_pages":
            page_uuids = scope.page_uuids or []
            if not page_uuids:
                return None
            placeholders = [self._add_param(u) for u in page_uuids]
            if scope.include_descendants:
                return (
                    f"pa.page_id IN (SELECT pa2.page_id FROM page_ancestors pa2 "
                    f"WHERE pa2.id IN ({', '.join(placeholders)}))"
                )
            return f"pa.page_id IN ({', '.join(placeholders)})"

        if scope_type == "linked_refs":
            if not self.current_node_uuid:
                return None
            target = self._add_param(self.current_node_uuid)
            self.params.append(self.workspace_id)
            self.params.append(self.current_node_uuid)
            return (
                f"(EXISTS (SELECT 1 FROM edge WHERE source_id = n.id AND target_id = {target} AND workspace_id = ?) "
                f"OR EXISTS (SELECT 1 FROM property_value WHERE node_id = n.id AND json_extract(value, '$.value') = ?))"
            )

        return None

    def _generate_group_sql(self, group: GroupNode) -> str | None:
        if not group.children:
            return None

        child_clauses: list[str] = []
        for child in group.children:
            if isinstance(child, GroupNode):
                nested = self._generate_group_sql(child)
                if nested:
                    child_clauses.append(f"({nested})")
            elif isinstance(child, NotNode):
                if isinstance(child.child, GroupNode):
                    nested = self._generate_group_sql(child.child)
                    if nested:
                        child_clauses.append(f"NOT ({nested})")
                else:
                    cond_sql = self._generate_condition_sql(child.child)
                    if cond_sql:
                        child_clauses.append(f"NOT ({cond_sql})")
            else:
                cond_sql = self._generate_condition_sql(child)
                if cond_sql:
                    child_clauses.append(cond_sql)

        if not child_clauses:
            return None

        logic_op = " AND " if group.logic == LogicType.AND else " OR "
        return logic_op.join(child_clauses)

    def _generate_condition_sql(self, condition: ConditionNode) -> str | None:
        if isinstance(condition, ClassCondition):
            return self._generate_class_condition(condition)
        if isinstance(condition, ExtendsCondition):
            return self._generate_extends_condition(condition)
        if isinstance(condition, PropertyCondition):
            return self._generate_property_condition(condition)
        if isinstance(condition, ContentCondition):
            return self._generate_content_condition(condition)
        if isinstance(condition, StyleCondition):
            return self._generate_style_condition(condition)
        if isinstance(condition, ReferenceCondition):
            return self._generate_reference_condition(condition)
        if isinstance(condition, ReferencePathCondition):
            return self._generate_reference_path_condition(condition)
        if isinstance(condition, ParentPathCondition):
            return self._generate_parent_path_condition(condition)
        if isinstance(condition, ParentCondition):
            return self._generate_parent_condition(condition)
        if isinstance(condition, ChildCondition):
            return self._generate_child_condition(condition)
        if isinstance(condition, ChildPathCondition):
            return self._generate_child_path_condition(condition)
        if isinstance(condition, PageCondition):
            return self._generate_page_condition(condition)
        if isinstance(condition, FlagCondition):
            return self._generate_flag_condition(condition)
        if isinstance(condition, TagCondition):
            logger.warning("TagCondition is out of scope for the SQLite derived schema")
            return None
        return None

    def _generate_class_condition(self, condition: ClassCondition) -> str | None:
        class_uuid = condition.class_uuid
        if not class_uuid or not class_uuid.strip():
            return None
        if "{" in class_uuid and "}" in class_uuid:
            logger.error("Unresolved placeholder in class_uuid: %s", class_uuid)
            return None

        operator = condition.operator or "contains"
        if operator == "defined":
            return "(json_array_length(n.class_ids) > 0)"
        if operator == "not_defined":
            return "(json_array_length(n.class_ids) = 0)"

        ph = self._add_param(class_uuid)
        match_sql = f"SELECT class_id FROM class_hierarchy WHERE ancestor_id = {ph}"
        exists = (
            f"EXISTS (SELECT 1 FROM json_each(n.class_ids) "
            f"WHERE value IN ({match_sql}))"
        )
        if operator == "does_not_contain":
            return f"NOT ({exists})"
        return exists

    def _generate_extends_condition(self, condition: ExtendsCondition) -> str | None:
        extends_uuid = condition.extends_class_uuid
        if not extends_uuid or not extends_uuid.strip():
            return None
        if "{" in extends_uuid and "}" in extends_uuid:
            logger.error("Unresolved placeholder in extends_class_uuid: %s", extends_uuid)
            return None

        ph = self._add_param(extends_uuid)
        return f"(n.id IN (SELECT class_id FROM class_hierarchy WHERE ancestor_id = {ph}))"

    def _generate_property_condition(self, condition: PropertyCondition) -> str | None:
        if not condition.property_name:
            return None

        prop_name = condition.property_name
        operator = condition.operator or PropertyOperator.EQUALS

        if prop_name in BUILTIN_COLUMNS:
            expr = BUILTIN_COLUMNS[prop_name]

            if operator == PropertyOperator.IS_EMPTY:
                return f"({expr} IS NULL OR {expr} = '')"
            if operator == PropertyOperator.IS_NOT_EMPTY:
                return f"({expr} IS NOT NULL AND {expr} != '')"

            if condition.value is None:
                return None

            value_ph = self._add_param(condition.value)

            if prop_name in ("create_date", "write_date"):
                return self._date_comparison(expr, operator, value_ph)

            if prop_name == "name":
                return self._text_comparison(expr, operator, value_ph, case_sensitive=False)

            return self._value_comparison(expr, operator, value_ph)

        # Custom property.
        if not condition.property_uuid:
            logger.warning("Property condition missing UUID, skipping (name=%r)", condition.property_name)
            return None

        prop_uuid_ph = self._add_param(condition.property_uuid)

        if operator == PropertyOperator.IS_EMPTY:
            return (
                f"NOT EXISTS (SELECT 1 FROM property_value pv "
                f"WHERE pv.node_id = n.id AND pv.property_schema_id = {prop_uuid_ph})"
            )
        if operator == PropertyOperator.IS_NOT_EMPTY:
            return (
                f"EXISTS (SELECT 1 FROM property_value pv "
                f"WHERE pv.node_id = n.id AND pv.property_schema_id = {prop_uuid_ph})"
            )

        if condition.value is None:
            return None

        value_ph = self._add_param(condition.value)
        return self._custom_property_comparison(
            condition.property_type, prop_uuid_ph, operator, value_ph
        )

    def _custom_property_comparison(
        self,
        property_type: PropertyType,
        prop_uuid_ph: str,
        operator: PropertyOperator,
        value_ph: str,
    ) -> str | None:
        value_expr = "json_extract(pv.value, '$.value')"
        base_exists = (
            f"EXISTS (SELECT 1 FROM property_value pv "
            f"WHERE pv.node_id = n.id AND pv.property_schema_id = {prop_uuid_ph} AND "
        )

        if property_type == PropertyType.NUMBER:
            numeric_expr = f"CAST({value_expr} AS REAL)"
            return self._value_comparison(numeric_expr, operator, value_ph, base_exists=base_exists)

        if property_type == PropertyType.CHECKBOX:
            bool_expr = f"({value_expr} = 1 OR LOWER({value_expr}) IN ('true', '1'))"
            if operator in (PropertyOperator.EQUALS, PropertyOperator.CONTAINS):
                return f"{base_exists}{bool_expr})"
            if operator == PropertyOperator.NOT_EQUALS:
                return f"{base_exists}NOT ({bool_expr}))"
            return None

        if property_type in (PropertyType.NODE, PropertyType.DATE, PropertyType.SELECT):
            return self._value_comparison(value_expr, operator, value_ph, base_exists=base_exists)

        if property_type == PropertyType.MULTI_SELECT:
            array_match = (
                f"EXISTS (SELECT 1 FROM json_each({value_expr}) WHERE value = {value_ph})"
            )
            if operator in (PropertyOperator.EQUALS, PropertyOperator.CONTAINS):
                return f"{base_exists}{array_match})"
            if operator == PropertyOperator.NOT_EQUALS:
                return f"{base_exists}NOT ({array_match}))"
            return None

        if property_type == PropertyType.DATE_RANGE:
            if operator == PropertyOperator.CONTAINS:
                return (
                    f"{base_exists}? BETWEEN DATE(json_extract(pv.value, '$.value.start')) "
                    f"AND DATE(json_extract(pv.value, '$.value.end')))"
                )
            if operator == PropertyOperator.EQUALS:
                return f"{base_exists}{value_expr} = {value_ph})"
            return None

        # Default text-like scalar.
        return self._text_comparison(value_expr, operator, value_ph, base_exists=base_exists)

    def _generate_content_condition(self, condition: ContentCondition) -> str | None:
        if not condition.value:
            return None

        value_ph = self._add_param(condition.value)
        text_expr = "COALESCE((SELECT content FROM search_index si WHERE si.node_id = n.id), '')"

        operator = condition.operator or ContentOperator.CONTAINS
        case_sensitive = condition.case_sensitive or False

        if operator == ContentOperator.CONTAINS:
            return self._text_comparison(text_expr, PropertyOperator.CONTAINS, value_ph, case_sensitive=case_sensitive)
        if operator == ContentOperator.STARTS_WITH:
            return self._text_comparison(text_expr, PropertyOperator.STARTS_WITH, value_ph, case_sensitive=case_sensitive)
        if operator == ContentOperator.ENDS_WITH:
            return self._text_comparison(text_expr, PropertyOperator.ENDS_WITH, value_ph, case_sensitive=case_sensitive)
        if operator == ContentOperator.EQUALS:
            return self._text_comparison(text_expr, PropertyOperator.EQUALS, value_ph, case_sensitive=case_sensitive)
        if operator == ContentOperator.REGEX:
            logger.warning("Regex content search is out of scope for SQLite derived schema")
            return None
        return None

    def _generate_style_condition(self, condition: StyleCondition) -> str | None:
        style_type = condition.style_type
        if isinstance(style_type, StyleType):
            style_type = style_type.value
        ast_type = STYLE_TO_AST_TYPE.get(style_type)
        if not ast_type:
            return None

        operator = condition.operator
        if isinstance(operator, StyleOperator):
            operator = operator.value

        value_ph = self._add_param(ast_type)
        exists = (
            f"EXISTS (SELECT 1 FROM json_tree(n.content) "
            f"WHERE json_tree.type = 'object' AND json_extract(json_tree.value, '$.type') = {value_ph})"
        )

        if operator == StyleOperator.CONTAINS.value:
            return f"({exists})"
        if operator == StyleOperator.DOES_NOT_CONTAIN.value:
            return f"NOT ({exists})"

        # `is` / `is_not` require every direct paragraph child to be of the mark type.
        all_styled = (
            "NOT EXISTS ("
            "SELECT 1 FROM json_each(n.content) AS block "
            "WHERE json_extract(block.value, '$.type') = 'paragraph' "
            "AND EXISTS ("
            "    SELECT 1 FROM json_each(json_extract(block.value, '$.children')) AS child "
            f"    WHERE json_extract(child.value, '$.type') != {value_ph}"
            "))"
        )
        if operator == StyleOperator.IS.value:
            return f"({exists} AND {all_styled})"
        if operator == StyleOperator.IS_NOT.value:
            return f"NOT ({exists} AND {all_styled})"
        return None

    def _generate_reference_condition(self, condition: ReferenceCondition) -> str | None:
        if not condition.target_uuid:
            return None
        target_ph = self._add_param(condition.target_uuid)
        self.params.append(self.workspace_id)
        self.params.append(condition.target_uuid)
        return (
            f"(EXISTS (SELECT 1 FROM edge WHERE source_id = n.id AND target_id = {target_ph} AND workspace_id = ?) "
            f"OR EXISTS (SELECT 1 FROM property_value WHERE node_id = n.id AND json_extract(value, '$.value') = ?))"
        )

    def _generate_reference_path_condition(self, condition: ReferencePathCondition) -> str | None:
        target_uuids = condition.target_uuids
        if not target_uuids:
            logger.warning("Dynamic reference_path groups are not yet supported by the SQLite compiler")
            return None

        valid = [u for u in target_uuids if u]
        if not valid:
            return None

        edge_placeholders = [self._add_param(u) for u in valid]
        prop_placeholders = [self._add_param(u) for u in valid]
        ancestor_placeholders = [self._add_param(u) for u in valid]
        edge_in = f"({', '.join(edge_placeholders)})"
        prop_in = f"({', '.join(prop_placeholders)})"
        ancestor_in = f"({', '.join(ancestor_placeholders)})"
        return f"""(
    EXISTS (
        WITH RECURSIVE ref_ancestors AS (
            SELECT id, parent_id, 0 AS depth FROM node WHERE id = n.id
            UNION ALL
            SELECT node.id, node.parent_id, ref_ancestors.depth + 1
            FROM node JOIN ref_ancestors ON node.id = ref_ancestors.parent_id
        )
        SELECT 1 FROM ref_ancestors a
        WHERE (
            EXISTS (SELECT 1 FROM edge WHERE source_id = a.id AND target_id IN {edge_in})
            OR EXISTS (SELECT 1 FROM property_value WHERE node_id = a.id AND json_extract(value, '$.value') IN {prop_in})
            OR (a.id IN {ancestor_in} AND a.depth > 0)
        )
    )
)"""

    def _generate_parent_path_condition(self, condition: ParentPathCondition) -> str | None:
        operator = condition.operator or "has_ancestor"

        if operator == "has_no_ancestor":
            return "n.parent_id IS NULL"
        if operator == "has_any_ancestor":
            return "n.parent_id IS NOT NULL"

        if not condition.nested_group or not condition.nested_group.children:
            return None

        if self._is_uuid_group(condition.nested_group):
            uuid_value = self._uuid_from_group(condition.nested_group)
            if not uuid_value:
                return None
            depth_clause = ""
            if condition.max_depth is not None:
                depth_clause = f" AND depth <= {self._add_param(condition.max_depth)}"
            uuid_ph = self._add_param(uuid_value)
            exists = (
                f"EXISTS (WITH RECURSIVE ancestors AS ("
                f"SELECT id, parent_id, 0 AS depth FROM node WHERE id = n.id "
                f"UNION ALL SELECT node.id, node.parent_id, ancestors.depth + 1 "
                f"FROM node JOIN ancestors ON node.id = ancestors.parent_id) "
                f"SELECT 1 FROM ancestors WHERE id = {uuid_ph} AND depth > 0{depth_clause})"
            )
            if operator == "not_has_ancestor":
                return f"NOT ({exists})"
            return exists

        # Dynamic nested group.
        nested_sql = self._generate_group_sql(condition.nested_group)
        if not nested_sql:
            return None
        parent_sql = self._alias_sql(nested_sql, "n.", "parent_n.")
        exists = (
            f"EXISTS (WITH RECURSIVE ancestors AS ("
            f"SELECT id, parent_id, 0 AS depth FROM node WHERE id = n.id "
            f"UNION ALL SELECT node.id, node.parent_id, ancestors.depth + 1 "
            f"FROM node JOIN ancestors ON node.id = ancestors.parent_id) "
            f"SELECT 1 FROM ancestors a JOIN node parent_n ON a.id = parent_n.id "
            f"WHERE a.depth > 0 AND parent_n.workspace_id = {self._add_param(self.workspace_id)} AND ({parent_sql}))"
        )
        if operator == "not_has_ancestor":
            return f"NOT ({exists})"
        return exists

    def _generate_parent_condition(self, condition: ParentCondition) -> str | None:
        operator = condition.operator or "has_parent"

        if operator == "has_no_parent":
            return "n.parent_id IS NULL"
        if operator == "has_any_parent":
            return "n.parent_id IS NOT NULL"

        parent_uuids = condition.parent_uuids or ([condition.parent_uuid] if condition.parent_uuid else [])
        if parent_uuids:
            valid = [u for u in parent_uuids if u and "{" not in u]
            if not valid:
                return None
            placeholders = [self._add_param(u) for u in valid]
            self.params.append(self.workspace_id)
            in_sql = f"(SELECT id FROM node WHERE id IN ({', '.join(placeholders)}) AND workspace_id = ?)"
            if operator == "not_has_parent":
                return f"n.parent_id NOT IN {in_sql}"
            return f"n.parent_id IN {in_sql}"

        if not condition.nested_group:
            return None

        nested_sql = self._generate_group_sql(condition.nested_group)
        if not nested_sql:
            return None
        parent_sql = self._alias_sql(nested_sql, "n.", "parent_n.")
        ws_ph = self._add_param(self.workspace_id)
        if operator == "not_has_parent":
            return (
                f"n.parent_id NOT IN ("
                f"SELECT parent_n.id FROM node parent_n "
                f"WHERE parent_n.workspace_id = {ws_ph} AND ({parent_sql}))"
            )
        return (
            f"n.parent_id IN ("
            f"SELECT parent_n.id FROM node parent_n "
            f"WHERE parent_n.workspace_id = {ws_ph} AND ({parent_sql}))"
        )

    def _generate_child_condition(self, condition: ChildCondition) -> str | None:
        operator = condition.operator or "has_child"

        if operator == "has_no_child":
            return "NOT EXISTS (SELECT 1 FROM node child_n WHERE child_n.parent_id = n.id)"
        if operator == "has_any_child":
            return "EXISTS (SELECT 1 FROM node child_n WHERE child_n.parent_id = n.id)"

        if condition.child_uuids:
            placeholders = [self._add_param(u) for u in condition.child_uuids]
            if operator == "not_has_child":
                return (
                    f"NOT EXISTS (SELECT 1 FROM node child_n "
                    f"WHERE child_n.parent_id = n.id AND child_n.id IN ({', '.join(placeholders)}))"
                )
            return (
                f"EXISTS (SELECT 1 FROM node child_n "
                f"WHERE child_n.parent_id = n.id AND child_n.id IN ({', '.join(placeholders)}))"
            )

        if not condition.nested_group:
            return None

        nested_sql = self._generate_group_sql(condition.nested_group)
        if not nested_sql:
            return None
        child_sql = self._alias_sql(nested_sql, "n.", "child_n.")
        if operator == "not_has_child":
            return (
                f"NOT EXISTS (SELECT 1 FROM node child_n "
                f"WHERE child_n.parent_id = n.id AND ({child_sql}))"
            )
        return (
            f"EXISTS (SELECT 1 FROM node child_n "
            f"WHERE child_n.parent_id = n.id AND ({child_sql}))"
        )

    def _generate_child_path_condition(self, condition: ChildPathCondition) -> str | None:
        operator = condition.operator or "has_descendant"

        if operator == "has_no_descendant":
            return "NOT EXISTS (SELECT 1 FROM node child WHERE child.parent_id = n.id)"
        if operator == "has_any_descendant":
            return "EXISTS (SELECT 1 FROM node child WHERE child.parent_id = n.id)"

        if not condition.nested_group or not condition.nested_group.children:
            return None

        if self._is_uuid_group(condition.nested_group):
            uuid_value = self._uuid_from_group(condition.nested_group)
            if not uuid_value:
                return None
            depth_clause = ""
            if condition.max_depth is not None:
                depth_clause = f" AND depth <= {self._add_param(condition.max_depth)}"
            uuid_ph = self._add_param(uuid_value)
            exists = (
                f"EXISTS (WITH RECURSIVE descendants AS ("
                f"SELECT id, parent_id, 0 AS depth FROM node WHERE id = n.id "
                f"UNION ALL SELECT node.id, node.parent_id, descendants.depth + 1 "
                f"FROM node JOIN descendants ON node.parent_id = descendants.id) "
                f"SELECT 1 FROM descendants WHERE id = {uuid_ph} AND depth > 0{depth_clause})"
            )
            if operator == "not_has_descendant":
                return f"NOT ({exists})"
            return exists

        # Dynamic nested group.
        nested_sql = self._generate_group_sql(condition.nested_group)
        if not nested_sql:
            return None
        child_sql = self._alias_sql(nested_sql, "n.", "child_n.")
        exists = (
            f"EXISTS (WITH RECURSIVE descendants AS ("
            f"SELECT id, parent_id, 0 AS depth FROM node WHERE id = n.id "
            f"UNION ALL SELECT node.id, node.parent_id, descendants.depth + 1 "
            f"FROM node JOIN descendants ON node.parent_id = descendants.id) "
            f"SELECT 1 FROM descendants d JOIN node child_n ON d.id = child_n.id "
            f"WHERE d.depth > 0 AND child_n.workspace_id = {self._add_param(self.workspace_id)} AND ({child_sql}))"
        )
        if operator == "not_has_descendant":
            return f"NOT ({exists})"
        return exists

    def _generate_page_condition(self, condition: PageCondition) -> str | None:
        operator = condition.operator or "is_page"

        if operator == "has_no_page":
            return "(pa.page_id IS NULL OR pa.depth = 0)"
        if operator == "has_any_page":
            return "pa.depth > 0"

        page_uuids = condition.page_uuids or ([condition.page_uuid] if condition.page_uuid else [])
        if page_uuids:
            resolved = []
            for u in page_uuids:
                if u == "{current_node_uuid}" and self.current_node_uuid:
                    resolved.append(self.current_node_uuid)
                else:
                    resolved.append(u)
            valid = [u for u in resolved if u and "{" not in u]
            if not valid:
                return None
            placeholders = [self._add_param(u) for u in valid]
            in_sql = f"({', '.join(placeholders)})"
            if operator == "is_not_page":
                return f"(pa.page_id IS NULL OR pa.depth = 0 OR pa.page_id NOT IN {in_sql})"
            return f"(pa.page_id IN {in_sql} AND pa.depth > 0)"

        if not condition.nested_group:
            return None

        nested_sql = self._generate_group_sql(condition.nested_group)
        if not nested_sql:
            return None
        page_sql = self._alias_sql(nested_sql, "n.", "page_n.")
        ws_ph = self._add_param(self.workspace_id)
        if operator == "is_not_page":
            return (
                f"(pa.page_id IS NULL OR pa.depth = 0 OR pa.page_id NOT IN ("
                f"SELECT page_n.id FROM node page_n "
                f"WHERE page_n.workspace_id = {ws_ph} AND ({page_sql})))"
            )
        return (
            f"(pa.page_id IN ("
            f"SELECT page_n.id FROM node page_n "
            f"WHERE page_n.workspace_id = {ws_ph} AND ({page_sql})) AND pa.depth > 0)"
        )

    def _generate_flag_condition(self, condition: FlagCondition) -> str | None:
        if not condition.flag_name:
            return None
        if condition.flag_name not in MAPPABLE_FLAGS:
            raise DomainError(
                message=(
                    f"Invalid flag_name: {condition.flag_name!r}. "
                    f"SQLite derived schema only supports: {', '.join(sorted(MAPPABLE_FLAGS))}."
                ),
                code="INVALID_FLAG_NAME",
            )
        expr = MAPPABLE_FLAGS[condition.flag_name]
        return expr if condition.value else f"NOT ({expr})"

    def _text_comparison(
        self,
        expr: str,
        operator: PropertyOperator | str,
        value_ph: str,
        *,
        case_sensitive: bool = False,
        base_exists: str | None = None,
    ) -> str | None:
        op = operator.value if isinstance(operator, PropertyOperator) else operator

        clause: str | None = None
        if op == PropertyOperator.EQUALS.value:
            clause = f"{expr} = {value_ph}" if case_sensitive else f"LOWER({expr}) = LOWER({value_ph})"
        elif op == PropertyOperator.NOT_EQUALS.value:
            clause = f"{expr} != {value_ph}" if case_sensitive else f"LOWER({expr}) != LOWER({value_ph})"
        elif op == PropertyOperator.CONTAINS.value:
            clause = f"{expr} LIKE '%' || {value_ph} || '%'" if case_sensitive else f"LOWER({expr}) LIKE '%' || LOWER({value_ph}) || '%'"
        elif op == PropertyOperator.STARTS_WITH.value:
            clause = f"{expr} LIKE {value_ph} || '%'" if case_sensitive else f"LOWER({expr}) LIKE LOWER({value_ph}) || '%'"
        elif op == PropertyOperator.ENDS_WITH.value:
            clause = f"{expr} LIKE '%' || {value_ph}" if case_sensitive else f"LOWER({expr}) LIKE '%' || LOWER({value_ph})"

        if clause is None:
            return None
        if base_exists:
            return f"{base_exists}{clause})"
        return clause

    def _value_comparison(
        self,
        expr: str,
        operator: PropertyOperator | str,
        value_ph: str,
        *,
        base_exists: str | None = None,
    ) -> str | None:
        op = operator.value if isinstance(operator, PropertyOperator) else operator

        operators_sql = {
            PropertyOperator.EQUALS.value: "=",
            PropertyOperator.NOT_EQUALS.value: "!=",
            PropertyOperator.GREATER_THAN.value: ">",
            PropertyOperator.LESS_THAN.value: "<",
            PropertyOperator.GREATER_THAN_OR_EQUALS.value: ">=",
            PropertyOperator.LESS_THAN_OR_EQUALS.value: "<=",
        }
        sql_op = operators_sql.get(op)
        if not sql_op:
            return None

        clause = f"{expr} {sql_op} {value_ph}"
        if base_exists:
            return f"{base_exists}{clause})"
        return clause

    def _date_comparison(self, expr: str, operator: PropertyOperator | str, value_ph: str) -> str | None:
        op = operator.value if isinstance(operator, PropertyOperator) else operator
        operators_sql = {
            PropertyOperator.EQUALS.value: "=",
            PropertyOperator.NOT_EQUALS.value: "!=",
            PropertyOperator.GREATER_THAN.value: ">",
            PropertyOperator.LESS_THAN.value: "<",
            PropertyOperator.GREATER_THAN_OR_EQUALS.value: ">=",
            PropertyOperator.LESS_THAN_OR_EQUALS.value: "<=",
        }
        sql_op = operators_sql.get(op)
        if not sql_op:
            return None
        return f"{expr} {sql_op} DATE({value_ph})"

    def _is_uuid_group(self, group: GroupNode) -> bool:
        return bool(group.children) and all(
            hasattr(child, "value") for child in group.children
        )

    def _uuid_from_group(self, group: GroupNode) -> str | None:
        for child in group.children:
            value = getattr(child, "value", None)
            if value:
                return str(value)
        return None

    def _alias_sql(self, sql: str, old: str, new: str) -> str:
        import re

        return re.sub(rf"\b{re.escape(old)}", new, sql)

    def _add_param(self, value: Any) -> str:
        """Append ``value`` to the parameter list and return a ``?`` placeholder."""
        self.params.append(value)
        return "?"


def generate_sql_from_ast(
    ast: QueryAST, workspace_id: str, current_node_uuid: str | None = None
) -> tuple[str, list[Any]]:
    """Convenience wrapper around :class:`QueryASTToSQLite`."""
    generator = QueryASTToSQLite(workspace_id, current_node_uuid)
    return generator.generate(ast)
