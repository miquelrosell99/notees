"""Node-level derived-state appliers."""

from __future__ import annotations

import json
import sqlite3

from app.core.clock import Hlc
from app.core.operation import Operation
from app.domain.entities.constants import SYSTEM_CLASS_UUIDS

from .child_order import (
    delete_child_order_by_node,
    insert_child_order,
    remove_child_order_for_child,
)
from .class_hierarchy import delete_class_hierarchy_for_node
from .crdt_state import delete_crdt_state_for_node
from .edge import rebuild_edges_for_node
from .node_view import delete_node_views_for_node
from .search import reindex_node


def node_exists(conn: sqlite3.Connection, node_id: str | None) -> bool:
    """Return ``True`` if ``node_id`` exists in the derived node table."""
    if node_id is None:
        return True
    row = conn.execute("SELECT 1 FROM node WHERE id = ?", (node_id,)).fetchone()
    return row is not None


def apply_node_create(conn: sqlite3.Connection, op: Operation) -> None:
    """Apply a ``node.create`` operation."""
    payload = op.payload
    node_id = payload["nodeId"]
    kind = payload["kind"]
    parent_id = payload.get("parentId")
    class_ids = payload.get("classIds") or []
    initial_content = payload.get("initialContent") or []
    ts = op.envelope.timestamp.isoformat() if op.envelope.timestamp else None

    icon = payload.get("icon")
    color = payload.get("color")
    conn.execute(
        """
        INSERT OR IGNORE INTO node (
            id, workspace_id, kind, class_ids, parent_id, content,
            icon, color, created_at, updated_at, created_by, updated_by
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            node_id,
            op.envelope.workspace_id,
            kind,
            json.dumps(class_ids),
            parent_id,
            json.dumps(initial_content),
            icon,
            color,
            ts,
            ts,
            op.envelope.actor_id,
            op.envelope.actor_id,
        ),
    )
    reindex_node(conn, node_id)
    rebuild_edges_for_node(conn, op)

    if parent_id is not None:
        position = str(payload.get("index", "0"))
        insert_child_order(conn, parent_id, node_id, position)


def apply_node_update_icon(conn: sqlite3.Connection, op: Operation) -> None:
    """Apply a ``node.updateIcon`` operation."""
    payload = op.payload
    node_id = payload["nodeId"]
    icon = payload.get("icon")
    ts = op.envelope.timestamp.isoformat() if op.envelope.timestamp else None

    conn.execute(
        "UPDATE node SET icon = ?, updated_at = ?, updated_by = ? WHERE id = ?",
        (icon, ts, op.envelope.actor_id, node_id),
    )


def apply_node_update_color(conn: sqlite3.Connection, op: Operation) -> None:
    """Apply a ``node.updateColor`` operation."""
    payload = op.payload
    node_id = payload["nodeId"]
    color = payload.get("color")
    ts = op.envelope.timestamp.isoformat() if op.envelope.timestamp else None

    conn.execute(
        "UPDATE node SET color = ?, updated_at = ?, updated_by = ? WHERE id = ?",
        (color, ts, op.envelope.actor_id, node_id),
    )


def apply_node_delete(conn: sqlite3.Connection, op: Operation) -> None:
    """Apply a ``node.delete`` operation.

    The operation log hard-deletes nodes; there is no soft-delete/trash concept
    in the derived ``node`` table. Before removing the row we record the deletion
    in ``trash`` with the timestamp and asset metadata needed by the retention
    cleanup scheduler. The ``node_asset`` row is authoritative for ``is_asset``
    and ``asset_hash``; we fall back to the asset class assignment for nodes that
    were created as assets without a file upload.
    """
    node_id = op.payload["nodeId"]
    ts = op.envelope.timestamp.isoformat() if op.envelope.timestamp else ""

    is_asset = 0
    asset_hash: str | None = None

    node_row = conn.execute(
        "SELECT class_ids FROM node WHERE id = ?", (node_id,)
    ).fetchone()
    asset_row = conn.execute(
        "SELECT asset_hash FROM node_asset WHERE node_id = ?", (node_id,)
    ).fetchone()

    if asset_row is not None:
        is_asset = 1
        asset_hash = asset_row["asset_hash"]
    elif node_row is not None:
        class_ids = set(json.loads(node_row["class_ids"]))
        if SYSTEM_CLASS_UUIDS["asset"] in class_ids:
            is_asset = 1

    conn.execute(
        """
        INSERT OR REPLACE INTO trash (node_id, deleted_at, is_asset, asset_hash)
        VALUES (?, ?, ?, ?)
        """,
        (node_id, ts, is_asset, asset_hash),
    )

    conn.execute("DELETE FROM node WHERE id = ?", (node_id,))
    delete_child_order_by_node(conn, node_id)
    conn.execute("DELETE FROM property_value WHERE node_id = ?", (node_id,))
    conn.execute("DELETE FROM property_value_tombstone WHERE node_id = ?", (node_id,))
    conn.execute("DELETE FROM property_schema WHERE node_id = ?", (node_id,))
    conn.execute("DELETE FROM class_property_edge WHERE class_id = ?", (node_id,))
    conn.execute(
        "DELETE FROM edge WHERE source_id = ? OR target_id = ?",
        (node_id, node_id),
    )
    delete_crdt_state_for_node(conn, node_id)
    conn.execute("DELETE FROM search_index WHERE node_id = ?", (node_id,))
    delete_class_hierarchy_for_node(conn, node_id)
    delete_node_views_for_node(conn, node_id)


def apply_node_move(conn: sqlite3.Connection, op: Operation) -> None:
    """Apply a ``node.move`` operation."""
    payload = op.payload
    node_id = payload["nodeId"]
    new_parent_id = payload.get("newParentId")
    position = str(payload.get("newIndex", "0"))
    ts = op.envelope.timestamp.isoformat() if op.envelope.timestamp else None

    conn.execute(
        "UPDATE node SET parent_id = ?, updated_at = ?, updated_by = ? WHERE id = ?",
        (new_parent_id, ts, op.envelope.actor_id, node_id),
    )

    remove_child_order_for_child(conn, node_id)

    if new_parent_id is not None:
        insert_child_order(conn, new_parent_id, node_id, position)


def apply_class_assign(conn: sqlite3.Connection, op: Operation) -> None:
    """Apply a ``class.assign`` operation."""
    payload = op.payload
    node_id = payload["nodeId"]
    class_id = payload["classId"]
    ts = op.envelope.timestamp.isoformat() if op.envelope.timestamp else None

    row = conn.execute(
        "SELECT class_ids FROM node WHERE id = ?", (node_id,)
    ).fetchone()
    if row is None:
        return

    ids = set(json.loads(row[0]))
    ids.add(class_id)
    conn.execute(
        "UPDATE node SET class_ids = ?, updated_at = ?, updated_by = ? WHERE id = ?",
        (json.dumps(sorted(ids)), ts, op.envelope.actor_id, node_id),
    )


def apply_class_unassign(conn: sqlite3.Connection, op: Operation) -> None:
    """Apply a ``class.unassign`` operation."""
    payload = op.payload
    node_id = payload["nodeId"]
    class_id = payload["classId"]
    ts = op.envelope.timestamp.isoformat() if op.envelope.timestamp else None

    row = conn.execute(
        "SELECT class_ids FROM node WHERE id = ?", (node_id,)
    ).fetchone()
    if row is None:
        return

    ids = set(json.loads(row[0]))
    ids.discard(class_id)
    conn.execute(
        "UPDATE node SET class_ids = ?, updated_at = ?, updated_by = ? WHERE id = ?",
        (json.dumps(sorted(ids)), ts, op.envelope.actor_id, node_id),
    )


def _node_hlc_from_row(row: sqlite3.Row) -> Hlc:
    return Hlc(physical=row["hlc_physical"], logical=row["hlc_logical"])


def apply_node_update_content(conn: sqlite3.Connection, op: Operation) -> None:
    """Apply a ``node.updateContent`` operation.

    Supports four payload shapes:

    * ``crdtUpdate`` — a simplified content AST (list or single dict). This is
      used by migration scripts and legacy content paths. Updates are merged
      with last-write-wins ordering using the operation HLC.
    * ``content`` — a direct AST payload (list or single dict) emitted by
      maintenance tools and whiteboard/query-block saves. Treated the same as
      ``crdtUpdate`` for storage.
    * ``textUpdate`` — a Yjs text update as a list of byte values (or bytes).
      The update is stored in ``crdt_state.text_state`` so the server can serve
      it back as a binary Yjs state blob; the node content is set to a minimal
      text placeholder because the server does not interpret Yjs updates.
    * ``treeUpdate`` — a Yjs array update for child-order CRDT state. Stored in
      ``crdt_state.tree_state`` without touching ``node.content``.
    """
    from app.core.clock import compare_hlc

    payload = op.payload
    node_id = payload["nodeId"]
    ts = op.envelope.timestamp.isoformat() if op.envelope.timestamp else None
    incoming_hlc = op.envelope.hlc

    text_update = payload.get("textUpdate")
    if text_update is not None:
        if isinstance(text_update, list):
            blob = bytes(text_update)
        elif isinstance(text_update, bytes):
            blob = text_update
        else:
            blob = b""

        conn.execute(
            """
            INSERT INTO crdt_state (node_id, text_state)
            VALUES (?, ?)
            ON CONFLICT (node_id) DO UPDATE
            SET text_state = EXCLUDED.text_state
            """,
            (node_id, blob),
        )
        content = [{"type": "text", "text": ""}]
        conn.execute(
            """
            UPDATE node
            SET content = ?, updated_at = ?, updated_by = ?,
                hlc_physical = ?, hlc_logical = ?
            WHERE id = ?
            """,
            (
                json.dumps(content),
                ts,
                op.envelope.actor_id,
                incoming_hlc.physical,
                incoming_hlc.logical,
                node_id,
            ),
        )
        reindex_node(conn, node_id)
        rebuild_edges_for_node(conn, op)
        return

    tree_update = payload.get("treeUpdate")
    if tree_update is not None:
        if isinstance(tree_update, list):
            blob = bytes(tree_update)
        elif isinstance(tree_update, bytes):
            blob = tree_update
        else:
            blob = b""

        conn.execute(
            """
            INSERT INTO crdt_state (node_id, tree_state)
            VALUES (?, ?)
            ON CONFLICT (node_id) DO UPDATE
            SET tree_state = EXCLUDED.tree_state
            """,
            (node_id, blob),
        )
        return

    existing = conn.execute(
        "SELECT hlc_physical, hlc_logical FROM node WHERE id = ?", (node_id,)
    ).fetchone()
    if existing is not None:
        existing_hlc = _node_hlc_from_row(existing)
        if compare_hlc(incoming_hlc, existing_hlc) <= 0:
            return

    content = []
    if "content" in payload:
        content_ast = payload["content"]
        if isinstance(content_ast, list):
            content = content_ast
        elif isinstance(content_ast, dict):
            content = [content_ast]
    else:
        crdt_update = payload.get("crdtUpdate")
        if isinstance(crdt_update, list):
            content = crdt_update
        elif isinstance(crdt_update, dict):
            content = [crdt_update]

    conn.execute(
        """
        UPDATE node
        SET content = ?, updated_at = ?, updated_by = ?,
            hlc_physical = ?, hlc_logical = ?
        WHERE id = ?
        """,
        (
            json.dumps(content),
            ts,
            op.envelope.actor_id,
            incoming_hlc.physical,
            incoming_hlc.logical,
            node_id,
        ),
    )
    reindex_node(conn, node_id)
    rebuild_edges_for_node(conn, op)


def apply_node_convert(conn: sqlite3.Connection, op: Operation) -> None:
    """Apply a ``node.convert`` operation, changing the node's kind and parent."""
    payload = op.payload
    node_id = payload["nodeId"]
    kind = payload["kind"]
    parent_id = payload.get("parentId")
    class_ids = payload.get("classIds") or []
    ts = op.envelope.timestamp.isoformat() if op.envelope.timestamp else None

    conn.execute(
        """
        UPDATE node
        SET kind = ?, parent_id = ?, class_ids = ?, updated_at = ?, updated_by = ?
        WHERE id = ?
        """,
        (
            kind,
            parent_id,
            json.dumps(class_ids),
            ts,
            op.envelope.actor_id,
            node_id,
        ),
    )
