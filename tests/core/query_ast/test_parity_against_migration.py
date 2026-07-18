"""Parity tests that validate QueryAST against real migrated SQLite state.

These tests replay the PostgreSQL → ideal-operations migration path for a small
number of workspaces and then run compiled QueryAST queries against the derived
SQLite store. They are marked as unit tests but are skipped when PostgreSQL is
not reachable, so they do not require Docker/PostgreSQL for the SQLite execution
path itself.
"""

from __future__ import annotations

from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import asyncpg
import pytest
import pytest_asyncio

from app.core.migration.assets import migrate_assets_for_workspace
from app.core.migration.connection import connect_postgres
from app.core.migration.links import (
    map_property_relation_targets,
    migrate_links_for_workspace,
)
from app.core.migration.nodes import (
    create_migration_context,
    migrate_nodes_for_workspace,
)
from app.core.migration.properties import migrate_properties_for_workspace
from app.core.migration.replay import replay_operations
from app.core.migration.validation import build_reconciliation_report
from app.core.migration.writer import InMemoryOperationWriter
from app.core.query_ast import QueryASTToSQLite
from app.core.uuid import uuidv7
from app.domain.entities.query_ast import (
    ClassCondition,
    ContentCondition,
    GroupNode,
    ParentCondition,
    PropertyCondition,
    PropertyOperator,
    PropertyType,
    QueryAST,
    ReferenceCondition,
    ScopeNode,
    ScopeType,
)

pytestmark = pytest.mark.unit


async def _load_first_migrated_workspace() -> tuple[str, Any, list[Any]]:
    """Migrate the first active workspace and replay it into SQLite.

    Returns:
        A tuple of (workspace_uuid, sqlite_connection, operations).
    """
    conn = await connect_postgres()
    writer = InMemoryOperationWriter()
    try:
        rows = await conn.fetch(
            "SELECT id FROM workspace WHERE active = TRUE ORDER BY id LIMIT 1"
        )
        if not rows:
            raise RuntimeError("No active workspaces found in PostgreSQL")

        workspace_int_id = rows[0]["id"]
        actor_id = uuidv7()
        physical_time = int(datetime.now(UTC).timestamp() * 1000)

        ctx = await create_migration_context(
            conn=conn,
            workspace_int_id=workspace_int_id,
            actor_id=actor_id,
            physical_time=physical_time,
        )
        await migrate_nodes_for_workspace(
            conn=conn,
            workspace_int_id=workspace_int_id,
            actor_id=actor_id,
            writer=writer,
            ctx=ctx,
        )
        prop_ops = await migrate_properties_for_workspace(
            conn=conn, workspace_int_id=workspace_int_id, ctx=ctx
        )
        for op in prop_ops:
            writer.write_operation(op)
        await map_property_relation_targets(
            conn=conn, workspace_int_id=workspace_int_id, ctx=ctx
        )
        await migrate_links_for_workspace(
            conn=conn,
            workspace_int_id=workspace_int_id,
            ctx=ctx,
            writer=writer,
        )
        await migrate_assets_for_workspace(
            conn=conn,
            workspace_int_id=workspace_int_id,
            ctx=ctx,
            writer=writer,
            data_dir=Path.home() / ".config" / "notees-backend-dev" / "data",
            copy_files=False,
        )

        report = build_reconciliation_report(writer.operations)
        assert report.orphan_count == 0, (
            f"Migration produced {report.orphan_count} orphan operations"
        )
        assert report.duplicate_count == 0, (
            f"Migration produced {report.duplicate_count} duplicate operations"
        )

        sqlite_conn = replay_operations(writer.operations)
        return ctx.workspace_uuid, sqlite_conn, writer.operations
    finally:
        await conn.close()
        writer.close()


@pytest_asyncio.fixture
async def migrated_workspace():
    try:
        workspace_uuid, sqlite_conn, operations = await _load_first_migrated_workspace()
    except (asyncpg.exceptions.PostgresError, OSError, TimeoutError) as exc:
        pytest.skip(f"PostgreSQL unavailable for migration parity tests: {exc}")
    try:
        yield workspace_uuid, sqlite_conn, operations
    finally:
        sqlite_conn.close()


def _execute_ast(
    ast: QueryAST, sqlite_conn: Any, workspace_uuid: str, current_node_uuid: str | None = None
) -> set[str]:
    compiler = QueryASTToSQLite(workspace_uuid, current_node_uuid)
    sql, params = compiler.generate(ast)
    return {row["id"] for row in sqlite_conn.execute(sql, params).fetchall()}


class TestMigrationParity:
    def test_pages_scope_returns_only_pages(self, migrated_workspace) -> None:
        workspace_uuid, conn, _ = migrated_workspace
        ast = QueryAST(scope=ScopeNode(scope_type=ScopeType.PAGES))
        result = _execute_ast(ast, conn, workspace_uuid)
        expected = {
            row["id"]
            for row in conn.execute(
                "SELECT id FROM node WHERE workspace_id = ? AND kind = 'page'",
                (workspace_uuid,),
            ).fetchall()
        }
        assert result == expected

    def test_class_condition_matches_assigned_nodes(self, migrated_workspace) -> None:
        workspace_uuid, conn, _ = migrated_workspace
        row = conn.execute(
            """
            SELECT id FROM node
            WHERE workspace_id = ? AND kind = 'class'
              AND id IN (SELECT class_id FROM class_hierarchy)
            LIMIT 1
            """,
            (workspace_uuid,),
        ).fetchone()
        if row is None:
            pytest.skip("No classes found in migrated workspace")
        class_uuid = row["id"]

        ast = QueryAST(
            root_group=GroupNode(
                children=[ClassCondition(class_uuid=class_uuid, operator="contains")]
            )
        )
        result = _execute_ast(ast, conn, workspace_uuid)
        expected = {
            row["id"]
            for row in conn.execute(
                """
                SELECT id FROM node
                WHERE workspace_id = ?
                  AND EXISTS (
                      SELECT 1 FROM json_each(class_ids)
                      WHERE value IN (
                          SELECT class_id FROM class_hierarchy WHERE ancestor_id = ?
                      )
                  )
                """,
                (workspace_uuid, class_uuid),
            ).fetchall()
        }
        assert result == expected

    def test_content_condition_matches_search_index(self, migrated_workspace) -> None:
        workspace_uuid, conn, _ = migrated_workspace
        row = conn.execute(
            "SELECT content FROM search_index WHERE content IS NOT NULL AND content != '' LIMIT 1"
        ).fetchone()
        if row is None:
            pytest.skip("No indexed content found in migrated workspace")
        term = row["content"].split()[0].lower()
        if not term:
            pytest.skip("Empty search term")

        ast = QueryAST(
            root_group=GroupNode(
                children=[ContentCondition(value=term, operator="contains")]
            )
        )
        result = _execute_ast(ast, conn, workspace_uuid)
        expected = {
            row["node_id"]
            for row in conn.execute(
                "SELECT node_id FROM search_index WHERE LOWER(content) LIKE ?",
                (f"%{term}%",),
            ).fetchall()
        }
        assert result == expected

    def test_property_text_filter_matches_property_value(
        self, migrated_workspace
    ) -> None:
        workspace_uuid, conn, _ = migrated_workspace
        row = conn.execute(
            """
            SELECT node_id, property_schema_id, json_extract(value, '$.value') AS val
            FROM property_value
            LIMIT 1
            """
        ).fetchone()
        if row is None:
            pytest.skip("No property values found in migrated workspace")
        schema_id = row["property_schema_id"]
        value = row["val"]
        if not isinstance(value, str) or not value.strip():
            pytest.skip("First property value is not a searchable string")
        term = value.split()[0]

        ast = QueryAST(
            root_group=GroupNode(
                children=[
                    PropertyCondition(
                        property_name="Property",
                        property_uuid=schema_id,
                        property_type=PropertyType.TEXT,
                        operator=PropertyOperator.CONTAINS,
                        value=term,
                    )
                ]
            )
        )
        result = _execute_ast(ast, conn, workspace_uuid)
        expected = {
            row["node_id"]
            for row in conn.execute(
                """
                SELECT node_id FROM property_value
                WHERE property_schema_id = ?
                  AND LOWER(json_extract(value, '$.value')) LIKE ?
                """,
                (schema_id, f"%{term.lower()}%"),
            ).fetchall()
        }
        assert result == expected

    def test_parent_condition_matches_direct_children(self, migrated_workspace) -> None:
        workspace_uuid, conn, _ = migrated_workspace
        row = conn.execute(
            """
            SELECT id, parent_id FROM node
            WHERE workspace_id = ? AND parent_id IS NOT NULL
            LIMIT 1
            """,
            (workspace_uuid,),
        ).fetchone()
        if row is None:
            pytest.skip("No child nodes found in migrated workspace")
        parent_uuid = row["parent_id"]

        ast = QueryAST(
            root_group=GroupNode(
                children=[
                    ParentCondition(parent_uuid=parent_uuid, operator="has_parent")
                ]
            )
        )
        result = _execute_ast(ast, conn, workspace_uuid)
        expected = {
            row["id"]
            for row in conn.execute(
                "SELECT id FROM node WHERE workspace_id = ? AND parent_id = ?",
                (workspace_uuid, parent_uuid),
            ).fetchall()
        }
        assert result == expected

    def test_reference_condition_matches_edge_table(self, migrated_workspace) -> None:
        workspace_uuid, conn, _ = migrated_workspace
        row = conn.execute(
            "SELECT target_id FROM edge WHERE workspace_id = ? LIMIT 1",
            (workspace_uuid,),
        ).fetchone()
        if row is None:
            pytest.skip("No edges found in migrated workspace")
        target_uuid = row["target_id"]

        ast = QueryAST(
            root_group=GroupNode(
                children=[ReferenceCondition(target_uuid=target_uuid)]
            )
        )
        result = _execute_ast(ast, conn, workspace_uuid)
        expected = {
            row["source_id"]
            for row in conn.execute(
                "SELECT source_id FROM edge WHERE workspace_id = ? AND target_id = ?",
                (workspace_uuid, target_uuid),
            ).fetchall()
        }
        assert result == expected
