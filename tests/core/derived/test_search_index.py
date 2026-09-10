"""Docid-mapped FTS maintenance for the derived search index.

FTS4 cannot index the notindexed node_id column, so maintenance by node_id
is a full docstore scan (O(n) per statement, O(n^2) on a large catch-up —
which held the workspace sync lock long enough to time out API requests).
All maintenance is addressed by docid through search_index_docid; these
tests pin the map contract: reindex replaces instead of duplicating, and
removals clean both tables.
"""

from __future__ import annotations

import json
import sqlite3

import pytest

from app.core.derived.schema import create_derived_schema
from app.core.derived.search import reindex_node, remove_search_index_entry

pytestmark = pytest.mark.unit


def _make_db() -> sqlite3.Connection:
    conn = sqlite3.connect(":memory:")
    create_derived_schema(conn)
    return conn


def _insert_node(conn: sqlite3.Connection, node_id: str, text: str) -> None:
    content = json.dumps([{"type": "text", "text": text}])
    conn.execute(
        "INSERT INTO node (id, workspace_id, kind, content) VALUES (?, 'ws', 'block', ?)",
        (node_id, content),
    )


def _index_rows(conn: sqlite3.Connection, node_id: str) -> list[tuple]:
    return conn.execute("SELECT node_id FROM search_index WHERE node_id = ?", (node_id,)).fetchall()


def test_reindex_inserts_findable_row_and_syncs_map() -> None:
    conn = _make_db()
    _insert_node(conn, "n1", "buy milk and eggs")

    reindex_node(conn, "n1")

    assert len(_index_rows(conn, "n1")) == 1
    (docid,) = conn.execute(
        "SELECT docid FROM search_index_docid WHERE node_id = ?", ("n1",)
    ).fetchone()
    assert docid is not None
    matches = conn.execute(
        "SELECT node_id FROM search_index WHERE content MATCH ?", ("mil*",)
    ).fetchall()
    assert [row[0] for row in matches] == ["n1"]


def test_reindex_replaces_instead_of_duplicating() -> None:
    conn = _make_db()
    _insert_node(conn, "n1", "buy milk")

    reindex_node(conn, "n1")
    conn.execute(
        "UPDATE node SET content = ? WHERE id = ?",
        (json.dumps([{"type": "text", "text": "call mom"}]), "n1"),
    )
    reindex_node(conn, "n1")
    reindex_node(conn, "n1")

    assert len(_index_rows(conn, "n1")) == 1
    assert conn.execute("SELECT COUNT(*) FROM search_index WHERE content MATCH 'milk'").fetchone()[0] == 0
    assert conn.execute("SELECT COUNT(*) FROM search_index WHERE content MATCH 'mom'").fetchone()[0] == 1


def test_reindex_removes_entry_and_map_row_when_content_empties() -> None:
    conn = _make_db()
    _insert_node(conn, "n1", "buy milk")
    reindex_node(conn, "n1")
    assert len(_index_rows(conn, "n1")) == 1

    conn.execute("UPDATE node SET content = '[]' WHERE id = 'n1'")
    reindex_node(conn, "n1")

    assert _index_rows(conn, "n1") == []
    assert (
        conn.execute("SELECT docid FROM search_index_docid WHERE node_id = ?", ("n1",)).fetchone()
        is None
    )


def test_remove_search_index_entry_cleans_both_tables() -> None:
    conn = _make_db()
    _insert_node(conn, "n1", "buy milk")
    _insert_node(conn, "n2", "call mom")
    reindex_node(conn, "n1")
    reindex_node(conn, "n2")

    remove_search_index_entry(conn, "n1")

    assert _index_rows(conn, "n1") == []
    assert len(_index_rows(conn, "n2")) == 1
    assert (
        conn.execute("SELECT docid FROM search_index_docid WHERE node_id = ?", ("n1",)).fetchone()
        is None
    )


def test_create_derived_schema_backfills_docid_map() -> None:
    # Simulate a pre-map database: schema with a populated search_index but an
    # empty map, then re-run schema creation (idempotent backfill path).
    conn = sqlite3.connect(":memory:")
    conn.executescript(
        """
        CREATE VIRTUAL TABLE search_index USING fts4(
            node_id, content, notindexed=node_id, tokenize=unicode61
        );
        INSERT INTO search_index (node_id, content) VALUES ('n1', 'buy milk');
        """
    )
    create_derived_schema(conn)

    (docid,) = conn.execute(
        "SELECT docid FROM search_index_docid WHERE node_id = ?", ("n1",)
    ).fetchone()
    assert docid is not None

    # Post-backfill reindex replaces instead of duplicating.
    _insert_node(conn, "n1", "feed the cat")
    reindex_node(conn, "n1")
    assert len(_index_rows(conn, "n1")) == 1
