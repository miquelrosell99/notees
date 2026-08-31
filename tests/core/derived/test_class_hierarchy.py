"""Unit tests for the class_hierarchy transitive-closure applier."""

from __future__ import annotations

import sqlite3

import pytest

from app.core.derived import replay_operations
from tests.core.derived.conftest import make_operation

pytestmark = pytest.mark.unit


def _closure(conn: sqlite3.Connection, class_id: str) -> set[str]:
    rows = conn.execute(
        "SELECT ancestor_id FROM class_hierarchy WHERE class_id = ?",
        (class_id,),
    ).fetchall()
    return {row["ancestor_id"] for row in rows}


def _reparenting_ops() -> list:
    """``X <- source <- book``; then source is reparented from X to Y."""
    return [
        make_operation("class.create", {"classId": "x", "name": "X"}),
        make_operation("class.create", {"classId": "y", "name": "Y"}, physical=2),
        make_operation("class.create", {"classId": "source", "name": "source"}, physical=3),
        make_operation("class.create", {"classId": "book", "name": "book"}, physical=4),
        make_operation(
            "class.setExtends",
            {"classId": "source", "extendsClassIds": ["x"]},
            physical=5,
        ),
        make_operation(
            "class.setExtends",
            {"classId": "book", "extendsClassIds": ["source"]},
            physical=6,
        ),
        make_operation(
            "class.setExtends",
            {"classId": "source", "extendsClassIds": ["y"]},
            physical=7,
        ),
    ]


class TestRecursiveClosureRecompute:
    def test_reparenting_a_class_updates_descendant_closures(self) -> None:
        conn = replay_operations(_reparenting_ops())

        assert _closure(conn, "source") == {"source", "y"}
        assert _closure(conn, "book") == {"book", "source", "y"}
        conn.close()

    def test_recompute_cascades_through_multiple_levels(self) -> None:
        ops = [
            make_operation("class.create", {"classId": "x", "name": "X"}),
            make_operation("class.create", {"classId": "y", "name": "Y"}, physical=2),
            make_operation("class.create", {"classId": "source", "name": "source"}, physical=3),
            make_operation("class.create", {"classId": "book", "name": "book"}, physical=4),
            make_operation("class.create", {"classId": "chapter", "name": "chapter"}, physical=5),
            make_operation(
                "class.setExtends", {"classId": "source", "extendsClassIds": ["x"]}, physical=6
            ),
            make_operation(
                "class.setExtends", {"classId": "book", "extendsClassIds": ["source"]}, physical=7
            ),
            make_operation(
                "class.setExtends", {"classId": "chapter", "extendsClassIds": ["book"]}, physical=8
            ),
            make_operation(
                "class.setExtends", {"classId": "source", "extendsClassIds": ["y"]}, physical=9
            ),
        ]
        conn = replay_operations(ops)

        assert _closure(conn, "chapter") == {"chapter", "book", "source", "y"}
        conn.close()

    def test_class_create_with_extends_builds_closure(self) -> None:
        ops = [
            make_operation("class.create", {"classId": "x", "name": "X"}),
            make_operation(
                "class.create",
                {"classId": "source", "name": "source", "extends": ["x"]},
                physical=2,
            ),
        ]
        conn = replay_operations(ops)

        assert _closure(conn, "source") == {"source", "x"}
        conn.close()

    def test_class_update_with_extends_recomputes_descendants(self) -> None:
        ops = [
            make_operation("class.create", {"classId": "x", "name": "X"}),
            make_operation("class.create", {"classId": "y", "name": "Y"}, physical=2),
            make_operation("class.create", {"classId": "source", "name": "source"}, physical=3),
            make_operation("class.create", {"classId": "book", "name": "book"}, physical=4),
            make_operation(
                "class.setExtends", {"classId": "source", "extendsClassIds": ["x"]}, physical=5
            ),
            make_operation(
                "class.setExtends", {"classId": "book", "extendsClassIds": ["source"]}, physical=6
            ),
            make_operation(
                "class.update",
                {"classId": "source", "name": "source", "extends": ["y"]},
                physical=7,
            ),
        ]
        conn = replay_operations(ops)

        assert _closure(conn, "source") == {"source", "y"}
        assert _closure(conn, "book") == {"book", "source", "y"}
        conn.close()

    def test_class_update_without_extends_keeps_closure(self) -> None:
        ops = [
            make_operation("class.create", {"classId": "x", "name": "X"}),
            make_operation(
                "class.create", {"classId": "source", "name": "source", "extends": ["x"]}, physical=2
            ),
            make_operation(
                "class.update", {"classId": "source", "name": "renamed"}, physical=3
            ),
        ]
        conn = replay_operations(ops)

        assert _closure(conn, "source") == {"source", "x"}
        conn.close()

    def test_replay_is_deterministic(self) -> None:
        first = replay_operations(_reparenting_ops())
        second = replay_operations(_reparenting_ops())

        query = "SELECT class_id, ancestor_id FROM class_hierarchy ORDER BY class_id, ancestor_id"
        assert [tuple(r) for r in first.execute(query)] == [
            tuple(r) for r in second.execute(query)
        ]
        first.close()
        second.close()


class TestCycleSafeReplay:
    def test_historical_cycle_does_not_crash_or_hang_replay(self) -> None:
        ops = [
            make_operation("class.create", {"classId": "a", "name": "A"}),
            make_operation("class.create", {"classId": "b", "name": "B"}, physical=2),
            make_operation(
                "class.setExtends", {"classId": "a", "extendsClassIds": ["b"]}, physical=3
            ),
            make_operation(
                "class.setExtends", {"classId": "b", "extendsClassIds": ["a"]}, physical=4
            ),
        ]
        conn = replay_operations(ops)

        # The closure stays bounded: each class has itself and the other class,
        # never a duplicate or unbounded ancestor set.
        assert _closure(conn, "a") == {"a", "b"}
        assert _closure(conn, "b") == {"a", "b"}
        conn.close()
