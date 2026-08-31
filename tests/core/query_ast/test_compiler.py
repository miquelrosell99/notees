"""Unit tests for the SQLite QueryAST compiler."""

from __future__ import annotations

import sqlite3
from uuid import uuid4

import pytest

from app.core.clock import Hlc
from app.core.migration.replay import replay_operations
from app.core.operation import Operation, OperationEnvelope
from app.core.query_ast import QueryASTToSQLite
from app.domain.entities.query_ast import (
    AggregationDimension,
    AggregationMeasure,
    AggregationNode,
    ClassCondition,
    ContentCondition,
    ContentOperator,
    FlagCondition,
    GroupNode,
    LogicType,
    NotNode,
    PageCondition,
    ParentCondition,
    PropertyCondition,
    PropertyOperator,
    PropertyType,
    QueryAST,
    ReferenceCondition,
    ScopeNode,
    TagCondition,
)

pytestmark = pytest.mark.unit


def _op(op_type: str, payload: dict, workspace_id: str = "ws-1", actor_id: str = "actor-1") -> Operation:
    return Operation(
        envelope=OperationEnvelope(
            workspace_id=workspace_id,
            actor_id=actor_id,
            hlc=Hlc(physical=1, logical=0),
            affected_node_ids=[payload.get("nodeId", payload.get("classId", "x"))],
            op_type=op_type,
        ),
        payload=payload,
    )


def _execute(ast: QueryAST, conn: sqlite3.Connection, current_node_uuid: str | None = None) -> list[str]:
    compiler = QueryASTToSQLite("ws-1", current_node_uuid)
    sql, params = compiler.generate(ast)
    return [row["id"] for row in conn.execute(sql, params).fetchall()]


class TestCompilerStructure:
    def test_entire_workspace_includes_workspace_filter(self) -> None:
        ast = QueryAST(scope=ScopeNode())
        sql, params = QueryASTToSQLite("ws-1").generate(ast)
        assert "n.workspace_id = ?" in sql
        assert "ws-1" in params

    def test_pages_scope_filters_by_kind(self) -> None:
        ast = QueryAST(scope=ScopeNode(scope_type="pages"))
        sql, _ = QueryASTToSQLite("ws-1").generate(ast)
        assert "n.kind = 'page'" in sql

    def test_class_condition_uses_class_hierarchy(self) -> None:
        ast = QueryAST(
            root_group=GroupNode(
                children=[ClassCondition(class_uuid=str(uuid4()), operator="contains")]
            )
        )
        sql, _ = QueryASTToSQLite("ws-1").generate(ast)
        assert "class_hierarchy" in sql
        assert "json_each(n.class_ids)" in sql

    def test_content_condition_uses_search_index(self) -> None:
        ast = QueryAST(
            root_group=GroupNode(
                children=[ContentCondition(value="hello", operator="contains")]
            )
        )
        sql, params = QueryASTToSQLite("ws-1").generate(ast)
        assert "search_index" in sql
        assert "hello" in params

    def test_not_condition_wraps_clause(self) -> None:
        ast = QueryAST(
            root_group=GroupNode(
                children=[NotNode(child=FlagCondition(flag_name="is_page"))]
            )
        )
        sql, _ = QueryASTToSQLite("ws-1").generate(ast)
        assert "NOT (" in sql

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
        sql, _ = QueryASTToSQLite("ws-1").generate(ast)
        assert " OR " in sql


class TestCompilerExecution:
    def test_pages_scope_returns_only_pages(self) -> None:
        ops = [
            _op("node.create", {"nodeId": "page-1", "kind": "page", "index": "0"}),
            _op("node.create", {"nodeId": "block-1", "kind": "block", "index": "0"}),
        ]
        conn = replay_operations(ops)
        ast = QueryAST(scope=ScopeNode(scope_type="pages"))
        assert _execute(ast, conn) == ["page-1"]
        conn.close()

    def test_class_condition_matches_assigned_class(self) -> None:
        ops = [
            _op("class.create", {"classId": "class-1", "name": "Class 1", "extends": []}),
            _op("node.create", {"nodeId": "page-1", "kind": "page", "index": "0"}),
            _op("class.assign", {"nodeId": "page-1", "classId": "class-1"}),
        ]
        conn = replay_operations(ops)
        ast = QueryAST(
            root_group=GroupNode(children=[ClassCondition(class_uuid="class-1")])
        )
        assert _execute(ast, conn) == ["page-1"]
        conn.close()

    def test_tag_condition_matches_class_assignment(self) -> None:
        ops = [
            _op("class.create", {"classId": "tag-1", "name": "Tag 1", "extends": []}),
            _op("node.create", {"nodeId": "page-1", "kind": "page", "index": "0"}),
            _op("class.assign", {"nodeId": "page-1", "classId": "tag-1"}),
            _op("node.create", {"nodeId": "page-2", "kind": "page", "index": "0"}),
        ]
        conn = replay_operations(ops)
        ast = QueryAST(
            root_group=GroupNode(children=[TagCondition(tag_uuid="tag-1")])
        )
        assert _execute(ast, conn) == ["page-1"]
        conn.close()

    def test_class_condition_matches_inherited_class(self) -> None:
        ops = [
            _op("class.create", {"classId": "parent-class", "name": "Parent", "extends": []}),
            _op("class.create", {"classId": "child-class", "name": "Child", "extends": ["parent-class"]}),
            _op("node.create", {"nodeId": "page-1", "kind": "page", "index": "0"}),
            _op("class.assign", {"nodeId": "page-1", "classId": "child-class"}),
        ]
        conn = replay_operations(ops)
        ast = QueryAST(
            root_group=GroupNode(children=[ClassCondition(class_uuid="parent-class")])
        )
        assert _execute(ast, conn) == ["page-1"]
        conn.close()

    def test_class_condition_tracks_reparented_ancestors(self) -> None:
        # X <- source <- book; reparenting source under Y must make a class:Y
        # query match book-classed nodes.
        ops = [
            _op("class.create", {"classId": "x", "name": "X"}),
            _op("class.create", {"classId": "y", "name": "Y"}),
            _op("class.create", {"classId": "source", "name": "source"}),
            _op("class.create", {"classId": "book", "name": "book"}),
            _op("class.setExtends", {"classId": "source", "extendsClassIds": ["x"]}),
            _op("class.setExtends", {"classId": "book", "extendsClassIds": ["source"]}),
            _op("node.create", {"nodeId": "page-1", "kind": "page", "index": "0"}),
            _op("class.assign", {"nodeId": "page-1", "classId": "book"}),
            _op("class.setExtends", {"classId": "source", "extendsClassIds": ["y"]}),
        ]
        conn = replay_operations(ops)
        ast = QueryAST(
            root_group=GroupNode(children=[ClassCondition(class_uuid="y")])
        )
        assert _execute(ast, conn) == ["page-1"]
        ast = QueryAST(
            root_group=GroupNode(children=[ClassCondition(class_uuid="x")])
        )
        assert _execute(ast, conn) == []
        conn.close()

    def test_content_condition_matches_text(self) -> None:
        ops = [
            _op("node.create", {"nodeId": "page-1", "kind": "page", "index": "0"}),
            _op(
                "node.updateContent",
                {"nodeId": "page-1", "crdtUpdate": [{"type": "text", "text": "hello world"}]},
            ),
            _op("node.create", {"nodeId": "page-2", "kind": "page", "index": "0"}),
        ]
        conn = replay_operations(ops)
        ast = QueryAST(
            root_group=GroupNode(children=[ContentCondition(value="hello", operator="contains")])
        )
        assert _execute(ast, conn) == ["page-1"]
        conn.close()

    def test_content_condition_fts_matches_prefix(self) -> None:
        ops = [
            _op("node.create", {"nodeId": "page-1", "kind": "page", "index": "0"}),
            _op(
                "node.updateContent",
                {"nodeId": "page-1", "crdtUpdate": [{"type": "text", "text": "Project planning"}]},
            ),
            _op("node.create", {"nodeId": "page-2", "kind": "page", "index": "0"}),
            _op(
                "node.updateContent",
                {"nodeId": "page-2", "crdtUpdate": [{"type": "text", "text": "Goodbye moon"}]},
            ),
        ]
        conn = replay_operations(ops)
        ast = QueryAST(
            root_group=GroupNode(
                children=[ContentCondition(value="proj", operator=ContentOperator.FTS)]
            )
        )
        assert _execute(ast, conn) == ["page-1"]
        conn.close()

    def test_property_builtin_uuid_filter(self) -> None:
        ops = [
            _op("node.create", {"nodeId": "page-1", "kind": "page", "index": "0"}),
            _op("node.create", {"nodeId": "page-2", "kind": "page", "index": "0"}),
        ]
        conn = replay_operations(ops)
        ast = QueryAST(
            root_group=GroupNode(
                children=[PropertyCondition(property_name="uuid", operator="equals", value="page-1")]
            )
        )
        assert _execute(ast, conn) == ["page-1"]
        conn.close()

    def test_property_custom_number_comparison(self) -> None:
        ops = [
            _op("node.create", {"nodeId": "page-1", "kind": "page", "index": "0"}),
            _op(
                "property.set",
                {
                    "propertyValueId": "pv-1",
                    "nodeId": "page-1",
                    "schemaId": "schema-1",
                    "index": 0,
                    "value": {"value": 42},
                },
            ),
            _op("node.create", {"nodeId": "page-2", "kind": "page", "index": "0"}),
        ]
        conn = replay_operations(ops)
        ast = QueryAST(
            root_group=GroupNode(
                children=[
                    PropertyCondition(
                        property_name="Custom",
                        property_uuid="schema-1",
                        property_type=PropertyType.NUMBER,
                        operator=PropertyOperator.GREATER_THAN,
                        value=10,
                    )
                ]
            )
        )
        assert _execute(ast, conn) == ["page-1"]
        conn.close()

    def test_reference_condition(self) -> None:
        ops = [
            _op("node.create", {"nodeId": "page-1", "kind": "page", "index": "0"}),
            _op(
                "node.updateContent",
                {"nodeId": "page-1", "crdtUpdate": [{"type": "ref", "targetId": "target-1"}]},
            ),
            _op("node.create", {"nodeId": "page-2", "kind": "page", "index": "0"}),
        ]
        conn = replay_operations(ops)
        ast = QueryAST(
            root_group=GroupNode(children=[ReferenceCondition(target_uuid="target-1")])
        )
        assert _execute(ast, conn) == ["page-1"]
        conn.close()

    def test_parent_condition(self) -> None:
        ops = [
            _op("node.create", {"nodeId": "parent", "kind": "page", "index": "0"}),
            _op(
                "node.create",
                {"nodeId": "child", "kind": "block", "parentId": "parent", "index": "0"},
            ),
            _op("node.create", {"nodeId": "other-page", "kind": "page", "index": "0"}),
        ]
        conn = replay_operations(ops)
        ast = QueryAST(
            root_group=GroupNode(
                children=[ParentCondition(parent_uuid="parent", operator="has_parent")]
            )
        )
        assert _execute(ast, conn) == ["child"]
        conn.close()

    def test_page_condition(self) -> None:
        ops = [
            _op("node.create", {"nodeId": "page-1", "kind": "page", "index": "0"}),
            _op(
                "node.create",
                {"nodeId": "block-1", "kind": "block", "parentId": "page-1", "index": "0"},
            ),
            _op(
                "node.create",
                {"nodeId": "block-2", "kind": "block", "parentId": "page-2", "index": "0"},
            ),
            _op("node.create", {"nodeId": "page-2", "kind": "page", "index": "0"}),
        ]
        conn = replay_operations(ops)
        ast = QueryAST(
            root_group=GroupNode(children=[PageCondition(page_uuid="page-1", operator="is_page")])
        )
        assert _execute(ast, conn) == ["block-1"]
        conn.close()

    def test_aggregate_query_groups_by_kind(self) -> None:
        ops = [
            _op("node.create", {"nodeId": "page-1", "kind": "page", "index": "0"}),
            _op(
                "node.create",
                {"nodeId": "block-1", "kind": "block", "parentId": "page-1", "index": "0"},
            ),
        ]
        conn = replay_operations(ops)
        ast = QueryAST(
            aggregation=AggregationNode(
                dimensions=[AggregationDimension(field="is_page")],
                measure=AggregationMeasure(function="count"),
            )
        )
        compiler = QueryASTToSQLite("ws-1")
        sql, params = compiler.generate_aggregate(ast)
        rows = conn.execute(sql, params).fetchall()
        groups = {bool(row["dim_0"]): row["value"] for row in rows}
        assert groups.get(True) == 1
        assert groups.get(False) == 1
        conn.close()
