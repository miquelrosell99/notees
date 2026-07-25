"""Derived-state appliers for the Notees operation log.

This package replays immutable operations into a SQLite derived-state database.
It mirrors the frontend appliers in ``frontend/src/core/derived/`` and is used
by both the migration validation suite and the server-side WorkspaceStore.
"""

from __future__ import annotations

import importlib
import sqlite3
from pathlib import Path
from typing import Any

from app.core.operation import Operation

from .activity import apply_activity_record
from .asset import apply_asset_delete, apply_asset_upload
from .class_hierarchy import apply_class_create, apply_class_update
from .favorite import apply_favorite_add, apply_favorite_remove, apply_favorite_reorder
from .link import apply_link_click
from .node import (
    apply_class_assign,
    apply_class_unassign,
    apply_node_convert,
    apply_node_create,
    apply_node_delete,
    apply_node_move,
    apply_node_update_content,
)
from .node_view import (
    apply_node_view_create,
    apply_node_view_delete,
    apply_node_view_reorder,
    apply_node_view_update,
)
from .plugin import apply_plugin_op
from .property import (
    apply_class_property_edge_create,
    apply_class_property_edge_delete,
    apply_class_property_edge_reorder,
    apply_class_property_edge_update,
    apply_property_schema_create,
    apply_property_schema_delete,
    apply_property_schema_update,
    apply_property_set,
    apply_property_unset,
)
from .schema import SCHEMA_SQL, create_derived_schema
from .share import (
    apply_share_public_create,
    apply_share_public_revoke,
    apply_share_user_grant,
    apply_share_user_revoke,
)
from .task import (
    apply_task_delete_completion,
    apply_task_delete_recurrence,
    apply_task_record_completion,
    apply_task_set_recurrence,
)

# ``class`` is a reserved keyword, so the module cannot be imported with a
# regular ``from .class import ...`` statement. Use importlib instead.
_class_module: Any = importlib.import_module("app.core.derived.class")
apply_class_operation = _class_module.apply_class_operation

__all__ = [
    "SCHEMA_SQL",
    "apply_operation",
    "create_derived_schema",
    "replay_operations",
]


def apply_operation(conn: sqlite3.Connection, op: Operation) -> None:
    """Apply a single operation to the derived SQLite state in ``conn``."""
    op_type = op.envelope.op_type
    if op_type == "node.create":
        apply_node_create(conn, op)
        apply_class_operation(conn, op)
    elif op_type == "node.delete":
        apply_class_operation(conn, op)
        apply_node_delete(conn, op)
    elif op_type == "node.move":
        apply_node_move(conn, op)
    elif op_type == "node.convert":
        apply_node_convert(conn, op)
        apply_class_operation(conn, op)
    elif op_type == "node.updateContent":
        apply_node_update_content(conn, op)
        apply_class_operation(conn, op)
    elif op_type == "class.assign":
        apply_class_assign(conn, op)
    elif op_type == "class.unassign":
        apply_class_unassign(conn, op)
    elif op_type == "property.set":
        apply_property_set(conn, op)
    elif op_type == "property.unset":
        apply_property_unset(conn, op)
    elif op_type == "propertySchema.create":
        apply_property_schema_create(conn, op)
    elif op_type == "propertySchema.update":
        apply_property_schema_update(conn, op)
    elif op_type == "propertySchema.delete":
        apply_property_schema_delete(conn, op)
    elif op_type == "classPropertyEdge.create":
        apply_class_property_edge_create(conn, op)
    elif op_type == "classPropertyEdge.update":
        apply_class_property_edge_update(conn, op)
    elif op_type == "classPropertyEdge.delete":
        apply_class_property_edge_delete(conn, op)
    elif op_type == "classPropertyEdge.reorder":
        apply_class_property_edge_reorder(conn, op)
    elif op_type == "class.create":
        apply_class_create(conn, op)
    elif op_type == "class.update":
        apply_class_update(conn, op)
    elif op_type == "nodeView.create":
        apply_node_view_create(conn, op)
    elif op_type == "nodeView.update":
        apply_node_view_update(conn, op)
    elif op_type == "nodeView.delete":
        apply_node_view_delete(conn, op)
    elif op_type == "nodeView.reorder":
        apply_node_view_reorder(conn, op)
    elif op_type == "asset.upload":
        apply_asset_upload(conn, op)
    elif op_type == "asset.delete":
        apply_asset_delete(conn, op)
    elif op_type == "task.recordCompletion":
        apply_task_record_completion(conn, op)
    elif op_type == "task.deleteCompletion":
        apply_task_delete_completion(conn, op)
    elif op_type == "task.setRecurrence":
        apply_task_set_recurrence(conn, op)
    elif op_type == "task.deleteRecurrence":
        apply_task_delete_recurrence(conn, op)
    elif op_type == "activity.record":
        apply_activity_record(conn, op)
    elif op_type == "link.click":
        apply_link_click(conn, op)
    elif op_type == "share.public.create":
        apply_share_public_create(conn, op)
    elif op_type == "share.public.revoke":
        apply_share_public_revoke(conn, op)
    elif op_type == "share.user.grant":
        apply_share_user_grant(conn, op)
    elif op_type == "share.user.revoke":
        apply_share_user_revoke(conn, op)
    elif op_type == "user.favorite.add":
        apply_favorite_add(conn, op)
    elif op_type == "user.favorite.remove":
        apply_favorite_remove(conn, op)
    elif op_type == "user.favorite.reorder":
        apply_favorite_reorder(conn, op)
    elif op_type == "plugin.op":
        apply_plugin_op(conn, op)
    else:
        raise ValueError(f"Unsupported op_type: {op_type!r}")


def replay_operations(
    operations: list[Operation],
    db_path: str | Path | None = None,
) -> sqlite3.Connection:
    """Replay ``operations`` into a SQLite database.

    Args:
        operations: Operations to apply, in the order they should be replayed.
        db_path: Path to a SQLite file. If ``None``, an in-memory database is
            used and returned.

    Returns:
        A ``sqlite3.Connection`` to the database containing the derived state.
    """
    if db_path is None:
        conn = sqlite3.connect(":memory:")
    else:
        Path(db_path).parent.mkdir(parents=True, exist_ok=True)
        conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row
    create_derived_schema(conn)
    for operation in operations:
        apply_operation(conn, operation)
    conn.commit()
    return conn
