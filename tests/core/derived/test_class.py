"""Unit tests for the class derived-state schema."""

from __future__ import annotations

import sqlite3

import pytest

from app.core.derived import create_derived_schema

pytestmark = pytest.mark.unit


class TestClassSchema:
    def test_class_table_is_created(self) -> None:
        conn = sqlite3.connect(":memory:")
        conn.row_factory = sqlite3.Row
        create_derived_schema(conn)

        row = conn.execute(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'class'"
        ).fetchone()

        assert row is not None
        assert row["name"] == "class"
        conn.close()

    def test_class_table_can_store_row(self) -> None:
        conn = sqlite3.connect(":memory:")
        conn.row_factory = sqlite3.Row
        create_derived_schema(conn)

        conn.execute(
            """
            INSERT INTO class (
                id,
                workspace_id,
                name,
                icon,
                color,
                description,
                extends_class_ids,
                active,
                created_at,
                updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                "c-1",
                "ws-1",
                "Project",
                "icon",
                "#ffffff",
                "A class description",
                "[]",
                1,
                "2026-07-25T00:00:00.000Z",
                "2026-07-25T00:00:00.000Z",
            ),
        )
        conn.commit()

        row = conn.execute(
            "SELECT id, workspace_id, name FROM class WHERE id = ?", ("c-1",)
        ).fetchone()

        assert row is not None
        assert row["id"] == "c-1"
        assert row["workspace_id"] == "ws-1"
        assert row["name"] == "Project"
        conn.close()
