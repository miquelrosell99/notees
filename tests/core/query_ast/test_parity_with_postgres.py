"""Cross-check the SQLite QueryAST compiler against the PostgreSQL compiler.

These tests do not require a running database. They build shared AST fixtures,
compile them with both compilers, and verify that the SQLite SQL is
structurally correct and syntactically executable against the derived schema.
"""

from __future__ import annotations

import sqlite3
from uuid import uuid4

import pytest

from app.core.migration.replay import create_derived_schema
from app.core.query_ast import QueryASTToSQLite
from app.domain.entities.query_ast import (
    AggregationDimension,
    AggregationMeasure,
    AggregationNode,
    ChildCondition,
    ChildPathCondition,
    ClassCondition,
    ContentCondition,
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
)
from app.domain.errors import DomainError
from app.domain.services.query_ast_sql import QueryASTToSQL

pytestmark = pytest.mark.unit

PG_WS_ID = 1
SQLITE_WS_ID = "ws-1"
CURRENT_UUID = str(uuid4())
PAGE_UUID = str(uuid4())
OTHER_PAGE_UUID = str(uuid4())
CLASS_UUID = str(uuid4())
PROP_UUID = str(uuid4())
TARGET_UUID = str(uuid4())
PARENT_UUID = str(uuid4())
CHILD_UUID = str(uuid4())


def _pg(ast: QueryAST, current_node_uuid: str | None = None) -> tuple[str, dict]:
    return QueryASTToSQL(PG_WS_ID, current_node_uuid).generate(ast)


def _lite(ast: QueryAST, current_node_uuid: str | None = None) -> tuple[str, list]:
    return QueryASTToSQLite(SQLITE_WS_ID, current_node_uuid).generate(ast)


def _assert_executes(sql: str, params: list) -> None:
    """Verify the SQLite SQL is syntactically valid against the derived schema."""
    conn = sqlite3.connect(":memory:")
    try:
        create_derived_schema(conn)
        conn.execute(sql, params).fetchall()
    finally:
        conn.close()


def _value_in_pg_params(value: str, pg_params: dict) -> bool:
    """Return True if ``value`` appears anywhere in PostgreSQL params."""
    for param_value in pg_params.values():
        if isinstance(param_value, list):
            if value in param_value:
                return True
        elif param_value == value:
            return True
    return False


class TestScopeParity:
    def test_entire_workspace(self) -> None:
        ast = QueryAST(scope=ScopeNode(scope_type=ScopeType.ENTIRE_WORKSPACE))
        pg_sql, pg_params = _pg(ast)
        lite_sql, lite_params = _lite(ast)
        assert "n.workspace_id = %(workspace_id)s" in pg_sql
        assert "n.workspace_id = ?" in lite_sql
        assert pg_params["workspace_id"] == PG_WS_ID
        assert SQLITE_WS_ID in lite_params
        _assert_executes(lite_sql, lite_params)

    def test_pages_scope(self) -> None:
        ast = QueryAST(scope=ScopeNode(scope_type=ScopeType.PAGES))
        pg_sql, _ = _pg(ast)
        lite_sql, lite_params = _lite(ast)
        assert "n.is_page = TRUE" in pg_sql
        assert "n.kind = 'page'" in lite_sql
        _assert_executes(lite_sql, lite_params)

    def test_current_page_with_descendants(self) -> None:
        ast = QueryAST(
            scope=ScopeNode(scope_type=ScopeType.CURRENT_PAGE, include_descendants=True)
        )
        pg_sql, pg_params = _pg(ast, current_node_uuid=CURRENT_UUID)
        lite_sql, lite_params = _lite(ast, current_node_uuid=CURRENT_UUID)
        assert "current_uuid" in pg_params
        assert _value_in_pg_params(CURRENT_UUID, pg_params)
        assert CURRENT_UUID in lite_params
        _assert_executes(lite_sql, lite_params)

    def test_specific_pages(self) -> None:
        ast = QueryAST(
            scope=ScopeNode(
                scope_type=ScopeType.SPECIFIC_PAGES,
                page_uuids=[PAGE_UUID, OTHER_PAGE_UUID],
            )
        )
        pg_sql, pg_params = _pg(ast)
        lite_sql, lite_params = _lite(ast)
        assert _value_in_pg_params(PAGE_UUID, pg_params)
        assert _value_in_pg_params(OTHER_PAGE_UUID, pg_params)
        assert PAGE_UUID in lite_params
        assert OTHER_PAGE_UUID in lite_params
        assert "pa.page_id" in lite_sql
        _assert_executes(lite_sql, lite_params)

    def test_specific_pages_with_descendants(self) -> None:
        ast = QueryAST(
            scope=ScopeNode(
                scope_type=ScopeType.SPECIFIC_PAGES,
                page_uuids=[PAGE_UUID],
                include_descendants=True,
            )
        )
        pg_sql, pg_params = _pg(ast)
        lite_sql, lite_params = _lite(ast)
        assert _value_in_pg_params(PAGE_UUID, pg_params)
        assert PAGE_UUID in lite_params
        # Workspace id is still present for the main workspace filter and CTE base.
        assert SQLITE_WS_ID in lite_params
        _assert_executes(lite_sql, lite_params)

    def test_linked_refs(self) -> None:
        ast = QueryAST(scope=ScopeNode(scope_type=ScopeType.LINKED_REFS))
        pg_sql, pg_params = _pg(ast, current_node_uuid=CURRENT_UUID)
        lite_sql, lite_params = _lite(ast, current_node_uuid=CURRENT_UUID)
        assert _value_in_pg_params(CURRENT_UUID, pg_params)
        assert CURRENT_UUID in lite_params
        assert "edge" in lite_sql
        _assert_executes(lite_sql, lite_params)


class TestConditionParity:
    def test_class_condition_contains(self) -> None:
        ast = QueryAST(
            root_group=GroupNode(
                children=[ClassCondition(class_uuid=CLASS_UUID, operator="contains")]
            )
        )
        pg_sql, pg_params = _pg(ast)
        lite_sql, lite_params = _lite(ast)
        assert "class_hierarchy" in pg_sql
        assert "class_hierarchy" in lite_sql
        assert _value_in_pg_params(CLASS_UUID, pg_params)
        assert CLASS_UUID in lite_params
        _assert_executes(lite_sql, lite_params)

    def test_class_condition_defined(self) -> None:
        ast = QueryAST(
            root_group=GroupNode(
                children=[ClassCondition(class_uuid=CLASS_UUID, operator="defined")]
            )
        )
        pg_sql, _ = _pg(ast)
        lite_sql, lite_params = _lite(ast)
        assert "array_length(n.class_ids, 1) > 0" in pg_sql
        assert "json_array_length(n.class_ids) > 0" in lite_sql
        _assert_executes(lite_sql, lite_params)

    def test_extends_condition(self) -> None:
        ast = QueryAST(
            root_group=GroupNode(children=[ExtendsCondition(extends_class_uuid=CLASS_UUID)])
        )
        pg_sql, pg_params = _pg(ast)
        lite_sql, lite_params = _lite(ast)
        assert "class_extend" in pg_sql
        assert "class_hierarchy" in lite_sql
        assert _value_in_pg_params(CLASS_UUID, pg_params)
        assert CLASS_UUID in lite_params
        _assert_executes(lite_sql, lite_params)

    def test_property_builtin_name(self) -> None:
        ast = QueryAST(
            root_group=GroupNode(
                children=[
                    PropertyCondition(
                        property_name="name",
                        operator=PropertyOperator.CONTAINS,
                        value="hello",
                    )
                ]
            )
        )
        pg_sql, pg_params = _pg(ast)
        lite_sql, lite_params = _lite(ast)
        assert "hello" in pg_params.values()
        assert "hello" in lite_params
        assert "search_index" in lite_sql
        _assert_executes(lite_sql, lite_params)

    def test_property_builtin_uuid(self) -> None:
        ast = QueryAST(
            root_group=GroupNode(
                children=[
                    PropertyCondition(
                        property_name="uuid",
                        operator=PropertyOperator.EQUALS,
                        value=PAGE_UUID,
                    )
                ]
            )
        )
        pg_sql, pg_params = _pg(ast)
        lite_sql, lite_params = _lite(ast)
        assert PAGE_UUID in pg_params.values()
        assert PAGE_UUID in lite_params
        _assert_executes(lite_sql, lite_params)

    def test_property_custom_text(self) -> None:
        ast = QueryAST(
            root_group=GroupNode(
                children=[
                    PropertyCondition(
                        property_name="Notes",
                        property_uuid=PROP_UUID,
                        property_type=PropertyType.TEXT,
                        operator=PropertyOperator.CONTAINS,
                        value="hello",
                    )
                ]
            )
        )
        pg_sql, pg_params = _pg(ast)
        lite_sql, lite_params = _lite(ast)
        assert PROP_UUID in pg_params.values()
        assert PROP_UUID in lite_params
        assert "property_value" in lite_sql
        _assert_executes(lite_sql, lite_params)

    def test_property_custom_number(self) -> None:
        ast = QueryAST(
            root_group=GroupNode(
                children=[
                    PropertyCondition(
                        property_name="Priority",
                        property_uuid=PROP_UUID,
                        property_type=PropertyType.NUMBER,
                        operator=PropertyOperator.GREATER_THAN,
                        value=10,
                    )
                ]
            )
        )
        pg_sql, pg_params = _pg(ast)
        lite_sql, lite_params = _lite(ast)
        assert PROP_UUID in pg_params.values()
        assert PROP_UUID in lite_params
        assert 10 in lite_params
        _assert_executes(lite_sql, lite_params)

    def test_content_condition(self) -> None:
        ast = QueryAST(
            root_group=GroupNode(
                children=[ContentCondition(value="hello", operator="contains")]
            )
        )
        pg_sql, pg_params = _pg(ast)
        lite_sql, lite_params = _lite(ast)
        assert "hello" in pg_params.values()
        assert "hello" in lite_params
        assert "search_index" in lite_sql
        _assert_executes(lite_sql, lite_params)

    def test_style_condition_contains(self) -> None:
        ast = QueryAST(
            root_group=GroupNode(
                children=[
                    StyleCondition(
                        style_type=StyleType.BOLD, operator=StyleOperator.CONTAINS
                    )
                ]
            )
        )
        pg_sql, _ = _pg(ast)
        lite_sql, lite_params = _lite(ast)
        assert "strong" in pg_sql
        # SQLite uses a positional parameter for the AST type; the literal is not
        # inlined into the SQL.
        assert "strong" in lite_params
        _assert_executes(lite_sql, lite_params)

    def test_reference_condition(self) -> None:
        ast = QueryAST(
            root_group=GroupNode(children=[ReferenceCondition(target_uuid=TARGET_UUID)])
        )
        pg_sql, pg_params = _pg(ast)
        lite_sql, lite_params = _lite(ast)
        assert _value_in_pg_params(TARGET_UUID, pg_params)
        assert TARGET_UUID in lite_params
        assert "edge" in lite_sql
        _assert_executes(lite_sql, lite_params)

    def test_reference_path_condition(self) -> None:
        ast = QueryAST(
            root_group=GroupNode(
                children=[ReferencePathCondition(target_uuids=[TARGET_UUID])]
            )
        )
        pg_sql, pg_params = _pg(ast)
        lite_sql, lite_params = _lite(ast)
        assert _value_in_pg_params(TARGET_UUID, pg_params)
        assert TARGET_UUID in lite_params
        assert "ref_ancestors" in lite_sql
        _assert_executes(lite_sql, lite_params)

    def test_parent_condition(self) -> None:
        ast = QueryAST(
            root_group=GroupNode(
                children=[
                    ParentCondition(parent_uuid=PARENT_UUID, operator="has_parent")
                ]
            )
        )
        pg_sql, pg_params = _pg(ast)
        lite_sql, lite_params = _lite(ast)
        assert _value_in_pg_params(PARENT_UUID, pg_params)
        assert PARENT_UUID in lite_params
        assert "n.parent_id IN" in lite_sql
        _assert_executes(lite_sql, lite_params)

    def test_parent_path_condition(self) -> None:
        ast = QueryAST(
            root_group=GroupNode(
                children=[
                    ParentPathCondition(
                        nested_group=GroupNode(
                            children=[ContentCondition(value="hello", operator="contains")]
                        ),
                        operator="has_ancestor",
                    )
                ]
            )
        )
        pg_sql, _ = _pg(ast)
        lite_sql, lite_params = _lite(ast)
        assert "ancestors" in pg_sql.lower()
        assert "ancestors" in lite_sql.lower()
        _assert_executes(lite_sql, lite_params)

    def test_child_condition(self) -> None:
        ast = QueryAST(
            root_group=GroupNode(
                children=[
                    ChildCondition(child_uuids=[CHILD_UUID], operator="has_child")
                ]
            )
        )
        pg_sql, pg_params = _pg(ast)
        lite_sql, lite_params = _lite(ast)
        assert _value_in_pg_params(CHILD_UUID, pg_params)
        assert CHILD_UUID in lite_params
        assert "child_n" in lite_sql
        _assert_executes(lite_sql, lite_params)

    def test_child_path_condition(self) -> None:
        ast = QueryAST(
            root_group=GroupNode(
                children=[
                    ChildPathCondition(
                        nested_group=GroupNode(
                            children=[ContentCondition(value="hello", operator="contains")]
                        ),
                        operator="has_descendant",
                    )
                ]
            )
        )
        pg_sql, _ = _pg(ast)
        lite_sql, lite_params = _lite(ast)
        assert "descendants" in lite_sql.lower()
        _assert_executes(lite_sql, lite_params)

    def test_page_condition(self) -> None:
        ast = QueryAST(
            root_group=GroupNode(
                children=[PageCondition(page_uuid=PAGE_UUID, operator="is_page")]
            )
        )
        pg_sql, pg_params = _pg(ast)
        lite_sql, lite_params = _lite(ast)
        assert _value_in_pg_params(PAGE_UUID, pg_params)
        assert PAGE_UUID in lite_params
        assert "pa.page_id" in lite_sql
        _assert_executes(lite_sql, lite_params)

    def test_flag_condition_is_page(self) -> None:
        ast = QueryAST(
            root_group=GroupNode(children=[FlagCondition(flag_name="is_page", value=True)])
        )
        pg_sql, _ = _pg(ast)
        lite_sql, lite_params = _lite(ast)
        assert "n.is_page = TRUE" in pg_sql
        assert "n.kind = 'page'" in lite_sql
        _assert_executes(lite_sql, lite_params)

    def test_flag_condition_unsupported_raises(self) -> None:
        ast = QueryAST(
            root_group=GroupNode(
                children=[FlagCondition(flag_name="is_favorite", value=True)]
            )
        )
        # PostgreSQL compiler supports is_favorite; SQLite derived schema does not.
        pg_sql, _ = _pg(ast)
        assert "n.is_favorite = TRUE" in pg_sql
        with pytest.raises(DomainError):
            _lite(ast)

    def test_tag_condition_out_of_scope_in_sqlite(self) -> None:
        from app.domain.entities.query_ast import TagCondition

        ast = QueryAST(
            root_group=GroupNode(
                children=[TagCondition(tag_uuid=TARGET_UUID, operator="is")]
            )
        )
        pg_sql, _ = _pg(ast)
        assert "tag_ids" in pg_sql
        lite_sql, lite_params = _lite(ast)
        # SQLite compiler returns None for tag conditions, so no extra clause is added.
        assert "tag" not in lite_sql.lower() or "tag_ids" not in lite_sql.lower()
        _assert_executes(lite_sql, lite_params)


class TestLogicParity:
    def test_not_condition(self) -> None:
        ast = QueryAST(
            root_group=GroupNode(children=[NotNode(child=FlagCondition(flag_name="is_page"))])
        )
        pg_sql, _ = _pg(ast)
        lite_sql, lite_params = _lite(ast)
        assert "NOT (" in pg_sql
        assert "NOT (" in lite_sql
        _assert_executes(lite_sql, lite_params)

    def test_or_logic(self) -> None:
        ast = QueryAST(
            root_group=GroupNode(
                logic=LogicType.OR,
                children=[
                    FlagCondition(flag_name="is_page"),
                    FlagCondition(flag_name="is_class"),
                ],
            )
        )
        pg_sql, _ = _pg(ast)
        lite_sql, lite_params = _lite(ast)
        assert " OR " in pg_sql
        assert " OR " in lite_sql
        _assert_executes(lite_sql, lite_params)


class TestAggregationParity:
    def test_count_by_kind(self) -> None:
        ast = QueryAST(
            aggregation=AggregationNode(
                dimensions=[AggregationDimension(field="is_page")],
                measure=AggregationMeasure(function="count"),
            )
        )
        pg_sql, pg_params = QueryASTToSQL(PG_WS_ID).generate_aggregate(ast)
        lite_sql, lite_params = QueryASTToSQLite(SQLITE_WS_ID).generate_aggregate(ast)
        assert "GROUP BY" in pg_sql
        assert "GROUP BY" in lite_sql
        assert "COUNT(*)" in pg_sql
        assert "COUNT(*)" in lite_sql
        assert "filtered_nodes" in lite_sql
        _assert_executes(lite_sql, lite_params)

    def test_sum_numeric_property(self) -> None:
        ast = QueryAST(
            aggregation=AggregationNode(
                dimensions=[AggregationDimension(field="is_page")],
                measure=AggregationMeasure(
                    function="sum", field=PROP_UUID, property_type="number"
                ),
            )
        )
        pg_sql, pg_params = QueryASTToSQL(PG_WS_ID).generate_aggregate(ast)
        lite_sql, lite_params = QueryASTToSQLite(SQLITE_WS_ID).generate_aggregate(ast)
        assert "SUM(" in pg_sql
        assert "SUM(" in lite_sql
        assert PROP_UUID in pg_params.values()
        assert PROP_UUID in lite_params
        _assert_executes(lite_sql, lite_params)
