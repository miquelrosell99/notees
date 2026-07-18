"""End-to-end tests: replay operations and run compiled QueryAST queries."""

from __future__ import annotations

import sqlite3

import pytest

from app.core.clock import Hlc
from app.core.migration.replay import replay_operations
from app.core.operation import Operation, OperationEnvelope
from app.core.query_ast import QueryASTToSQLite
from app.domain.entities.query_ast import (
    ClassCondition,
    ContentCondition,
    GroupNode,
    ParentPathCondition,
    PropertyCondition,
    PropertyOperator,
    PropertyType,
    QueryAST,
    ReferencePathCondition,
    ScopeNode,
)

pytestmark = pytest.mark.unit


def _op(op_type: str, payload: dict, workspace_id: str = "ws-1") -> Operation:
    return Operation(
        envelope=OperationEnvelope(
            workspace_id=workspace_id,
            actor_id="actor-1",
            hlc=Hlc(physical=1, logical=0),
            affected_node_ids=[payload.get("nodeId", payload.get("classId", "x"))],
            op_type=op_type,
        ),
        payload=payload,
    )


def _ids(conn: sqlite3.Connection, ast: QueryAST, current_node_uuid: str | None = None) -> set[str]:
    compiler = QueryASTToSQLite("ws-1", current_node_uuid)
    sql, params = compiler.generate(ast)
    return {row["id"] for row in conn.execute(sql, params).fetchall()}


class TestClassHierarchyReplay:
    def test_class_create_populates_hierarchy(self) -> None:
        ops = [
            _op("class.create", {"classId": "animal", "name": "Animal", "extends": []}),
            _op("class.create", {"classId": "mammal", "name": "Mammal", "extends": ["animal"]}),
            _op("class.create", {"classId": "dog", "name": "Dog", "extends": ["mammal"]}),
        ]
        conn = replay_operations(ops)
        rows = conn.execute("SELECT class_id, ancestor_id FROM class_hierarchy ORDER BY class_id, ancestor_id").fetchall()
        pairs = {(r["class_id"], r["ancestor_id"]) for r in rows}
        assert pairs == {
            ("animal", "animal"),
            ("mammal", "mammal"),
            ("mammal", "animal"),
            ("dog", "dog"),
            ("dog", "mammal"),
            ("dog", "animal"),
        }
        conn.close()

    def test_class_update_recomputes_ancestors(self) -> None:
        ops = [
            _op("class.create", {"classId": "a", "name": "A", "extends": []}),
            _op("class.create", {"classId": "b", "name": "B", "extends": ["a"]}),
            _op("class.create", {"classId": "c", "name": "C", "extends": ["b"]}),
            _op("class.update", {"classId": "c", "extends": ["a"]}),
        ]
        conn = replay_operations(ops)
        rows = conn.execute("SELECT ancestor_id FROM class_hierarchy WHERE class_id = 'c'").fetchall()
        assert {r["ancestor_id"] for r in rows} == {"c", "a"}
        conn.close()


class TestEndToEndQueries:
    def test_current_page_scope_includes_descendants(self) -> None:
        ops = [
            _op("node.create", {"nodeId": "page-1", "kind": "page", "index": "0"}),
            _op(
                "node.create",
                {"nodeId": "child-1", "kind": "block", "parentId": "page-1", "index": "0"},
            ),
            _op(
                "node.create",
                {"nodeId": "grandchild", "kind": "block", "parentId": "child-1", "index": "0"},
            ),
            _op("node.create", {"nodeId": "page-2", "kind": "page", "index": "0"}),
        ]
        conn = replay_operations(ops)
        ast = QueryAST(scope=ScopeNode(scope_type="current_page", include_descendants=True))
        result = _ids(conn, ast, current_node_uuid="page-1")
        assert result == {"page-1", "child-1", "grandchild"}
        conn.close()

    def test_reference_path_finds_nested_references(self) -> None:
        ops = [
            _op("node.create", {"nodeId": "target", "kind": "page", "index": "0"}),
            _op("node.create", {"nodeId": "page-1", "kind": "page", "index": "0"}),
            _op(
                "node.create",
                {"nodeId": "block-1", "kind": "block", "parentId": "page-1", "index": "0"},
            ),
            _op(
                "node.updateContent",
                {"nodeId": "block-1", "crdtUpdate": [{"type": "ref", "targetId": "target"}]},
            ),
        ]
        conn = replay_operations(ops)
        ast = QueryAST(
            root_group=GroupNode(
                children=[ReferencePathCondition(target_uuids=["target"])]
            )
        )
        result = _ids(conn, ast)
        assert result == {"block-1"}
        conn.close()

    def test_parent_path_finds_descendants_of_page(self) -> None:
        ops = [
            _op("node.create", {"nodeId": "page-1", "kind": "page", "index": "0"}),
            _op(
                "node.create",
                {"nodeId": "child", "kind": "block", "parentId": "page-1", "index": "0"},
            ),
            _op(
                "node.create",
                {"nodeId": "grandchild", "kind": "block", "parentId": "child", "index": "0"},
            ),
            _op("node.create", {"nodeId": "page-2", "kind": "page", "index": "0"}),
        ]
        conn = replay_operations(ops)
        ast = QueryAST(
            root_group=GroupNode(
                children=[
                    ParentPathCondition(
                        nested_group=GroupNode(children=[ContentCondition(value="page-1")]),
                        operator="has_ancestor",
                    )
                ]
            ),
        )
        result = _ids(conn, ast)
        assert result == {"child", "grandchild"}
        conn.close()

    def test_property_text_filter_on_replayed_data(self) -> None:
        ops = [
            _op("node.create", {"nodeId": "page-1", "kind": "page", "index": "0"}),
            _op(
                "property.set",
                {
                    "propertyValueId": "pv-1",
                    "nodeId": "page-1",
                    "schemaId": "schema-1",
                    "index": 0,
                    "value": {"value": "urgent note"},
                },
            ),
            _op("node.create", {"nodeId": "page-2", "kind": "page", "index": "0"}),
        ]
        conn = replay_operations(ops)
        ast = QueryAST(
            root_group=GroupNode(
                children=[
                    PropertyCondition(
                        property_name="Notes",
                        property_uuid="schema-1",
                        property_type=PropertyType.TEXT,
                        operator=PropertyOperator.CONTAINS,
                        value="urgent",
                    )
                ]
            )
        )
        result = _ids(conn, ast)
        assert result == {"page-1"}
        conn.close()

    def test_content_and_class_combined(self) -> None:
        ops = [
            _op("class.create", {"classId": "task", "name": "Task", "extends": []}),
            _op("node.create", {"nodeId": "task-1", "kind": "page", "index": "0"}),
            _op("class.assign", {"nodeId": "task-1", "classId": "task"}),
            _op(
                "node.updateContent",
                {"nodeId": "task-1", "crdtUpdate": [{"type": "text", "text": "buy milk"}]},
            ),
            _op("node.create", {"nodeId": "task-2", "kind": "page", "index": "0"}),
            _op("class.assign", {"nodeId": "task-2", "classId": "task"}),
            _op(
                "node.updateContent",
                {"nodeId": "task-2", "crdtUpdate": [{"type": "text", "text": "walk dog"}]},
            ),
        ]
        conn = replay_operations(ops)
        ast = QueryAST(
            root_group=GroupNode(
                children=[
                    ClassCondition(class_uuid="task"),
                    ContentCondition(value="milk", operator="contains"),
                ]
            )
        )
        result = _ids(conn, ast)
        assert result == {"task-1"}
        conn.close()
