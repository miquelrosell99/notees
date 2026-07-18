"""Local-first WorkspaceStore for the Notees operation log.

This is a Python port of the browser ``WorkspaceStore`` in
``frontend/src/core/store.ts``. It maintains an immutable operation log plus a
SQLite derived-state database, and applies operations through the same appliers
used by the migration replay tooling.
"""

from __future__ import annotations

import json
import sqlite3
from datetime import UTC, datetime
from typing import Any

from app.core.clock import Clock, Hlc, max_hlc
from app.core.migration.replay import apply_operation, create_derived_schema
from app.core.operation import Operation, create_operation

_SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS operation (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    actor_id TEXT NOT NULL,
    hlc_physical INTEGER NOT NULL,
    hlc_logical INTEGER NOT NULL,
    affected_node_ids TEXT NOT NULL,
    op_type TEXT NOT NULL,
    payload TEXT NOT NULL,
    timestamp TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_operation_workspace_hlc
    ON operation (workspace_id, hlc_physical, hlc_logical);

CREATE TABLE IF NOT EXISTS sync_watermark (
    workspace_id TEXT PRIMARY KEY,
    hlc_physical INTEGER NOT NULL,
    hlc_logical INTEGER NOT NULL
);
"""


def _init_schema(conn: sqlite3.Connection) -> None:
    create_derived_schema(conn)
    conn.executescript(_SCHEMA_SQL)
    conn.commit()


class WorkspaceStore:
    """Applies operations to a SQLite operation log and derived state."""

    def __init__(
        self,
        conn: sqlite3.Connection,
        workspace_id: str,
        actor_id: str,
    ) -> None:
        self._conn = conn
        self._conn.row_factory = sqlite3.Row
        self._workspace_id = workspace_id
        self._actor_id = actor_id
        self._clock = Clock(device_id=actor_id)
        _init_schema(conn)
        self._watermark = self._load_watermark()

    @property
    def workspace_id(self) -> str:
        return self._workspace_id

    @property
    def actor_id(self) -> str:
        return self._actor_id

    def get_db(self) -> sqlite3.Connection:
        return self._conn

    def _load_watermark(self) -> Hlc:
        row = self._conn.execute(
            "SELECT hlc_physical, hlc_logical FROM sync_watermark WHERE workspace_id = ?",
            (self._workspace_id,),
        ).fetchone()
        return Hlc(physical=row[0], logical=row[1]) if row else Hlc(0, 0)

    def _save_watermark(self, hlc: Hlc) -> None:
        self._conn.execute(
            """
            INSERT INTO sync_watermark (workspace_id, hlc_physical, hlc_logical)
            VALUES (?, ?, ?)
            ON CONFLICT(workspace_id) DO UPDATE SET
                hlc_physical = excluded.hlc_physical,
                hlc_logical = excluded.hlc_logical
            """,
            (self._workspace_id, hlc.physical, hlc.logical),
        )
        self._conn.commit()

    def _advance_clock(self) -> Hlc:
        return self._clock.advance(int(datetime.now(UTC).timestamp() * 1000))

    def apply(self, op: Operation) -> None:
        """Apply an operation to the store if it is newer than the watermark.

        Idempotent: operations whose id already exists in the operation log are
        ignored. The watermark is advanced to the operation's HLC.
        """
        existing = self._conn.execute(
            "SELECT 1 FROM operation WHERE id = ?", (op.envelope.id,)
        ).fetchone()
        if existing is not None:
            return

        self._conn.execute(
            """
            INSERT INTO operation (
                id, workspace_id, actor_id, hlc_physical, hlc_logical,
                affected_node_ids, op_type, payload, timestamp
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                op.envelope.id,
                op.envelope.workspace_id,
                op.envelope.actor_id,
                op.envelope.hlc.physical,
                op.envelope.hlc.logical,
                json.dumps(op.envelope.affected_node_ids),
                op.envelope.op_type,
                json.dumps(op.payload),
                datetime.now(UTC).isoformat(),
            ),
        )
        apply_operation(self._conn, op)
        self._conn.commit()

        self._watermark = max_hlc(self._watermark, op.envelope.hlc)
        self._save_watermark(self._watermark)
        self._clock.update(op.envelope.hlc, int(datetime.now(UTC).timestamp() * 1000))

    def create_node(
        self,
        node_id: str,
        kind: str = "block",
        parent_id: str | None = None,
        class_ids: list[str] | None = None,
        initial_content: list[dict[str, Any]] | None = None,
    ) -> None:
        op = create_operation(
            {
                "workspace_id": self._workspace_id,
                "actor_id": self._actor_id,
                "hlc": self._advance_clock(),
                "affected_node_ids": [node_id],
                "op_type": "node.create",
            },
            {
                "nodeId": node_id,
                "kind": kind,
                "parentId": parent_id,
                "classIds": class_ids or [],
                "initialContent": initial_content or [],
            },
        )
        self.apply(op)

    def delete_node(self, node_id: str) -> None:
        op = create_operation(
            {
                "workspace_id": self._workspace_id,
                "actor_id": self._actor_id,
                "hlc": self._advance_clock(),
                "affected_node_ids": [node_id],
                "op_type": "node.delete",
            },
            {"nodeId": node_id},
        )
        self.apply(op)

    def move_node(
        self,
        node_id: str,
        new_parent_id: str | None,
        new_index: int = 0,
    ) -> None:
        op = create_operation(
            {
                "workspace_id": self._workspace_id,
                "actor_id": self._actor_id,
                "hlc": self._advance_clock(),
                "affected_node_ids": [node_id, new_parent_id] if new_parent_id else [node_id],
                "op_type": "node.move",
            },
            {"nodeId": node_id, "newParentId": new_parent_id, "newIndex": new_index},
        )
        self.apply(op)

    def update_content(
        self,
        node_id: str,
        content: list[dict[str, Any]],
    ) -> None:
        """Replace the node content with a deterministic AST.

        This is a test helper that bypasses the CRDT text type. It emits a
        ``node.updateContent`` operation whose ``crdtUpdate`` is treated by the
        replay applier as the new content AST.
        """
        op = create_operation(
            {
                "workspace_id": self._workspace_id,
                "actor_id": self._actor_id,
                "hlc": self._advance_clock(),
                "affected_node_ids": [node_id],
                "op_type": "node.updateContent",
            },
            {"nodeId": node_id, "crdtUpdate": content},
        )
        self.apply(op)

    def set_property(
        self,
        *,
        property_value_id: str,
        node_id: str,
        schema_id: str,
        value: Any,
        index: int = 0,
    ) -> None:
        op = create_operation(
            {
                "workspace_id": self._workspace_id,
                "actor_id": self._actor_id,
                "hlc": self._advance_clock(),
                "affected_node_ids": [node_id],
                "op_type": "property.set",
            },
            {
                "propertyValueId": property_value_id,
                "nodeId": node_id,
                "schemaId": schema_id,
                "index": index,
                "value": value,
            },
        )
        self.apply(op)

    def unset_property(
        self,
        *,
        node_id: str,
        schema_id: str,
        index: int = 0,
    ) -> None:
        op = create_operation(
            {
                "workspace_id": self._workspace_id,
                "actor_id": self._actor_id,
                "hlc": self._advance_clock(),
                "affected_node_ids": [node_id],
                "op_type": "property.unset",
            },
            {"nodeId": node_id, "schemaId": schema_id, "index": index},
        )
        self.apply(op)

    def get_node(self, node_id: str) -> dict[str, Any] | None:
        row = self._conn.execute(
            """
            SELECT
                id,
                workspace_id,
                kind,
                parent_id,
                class_ids,
                content,
                created_at,
                updated_at,
                created_by,
                updated_by
            FROM node
            WHERE id = ?
            """,
            (node_id,),
        ).fetchone()
        if row is None:
            return None
        return {
            "id": row[0],
            "workspace_id": row[1],
            "kind": row[2],
            "parent_id": row[3],
            "class_ids": json.loads(row[4]),
            "content": json.loads(row[5]),
            "created_at": row[6],
            "updated_at": row[7],
            "created_by": row[8],
            "updated_by": row[9],
        }

    def get_children(self, parent_id: str) -> list[str]:
        rows = self._conn.execute(
            "SELECT child_id FROM node_child_order WHERE parent_id = ? ORDER BY position",
            (parent_id,),
        ).fetchall()
        return [row[0] for row in rows]

    def get_property(
        self,
        *,
        node_id: str,
        schema_id: str,
        index: int = 0,
    ) -> Any | None:
        row = self._conn.execute(
            "SELECT value FROM property_value WHERE node_id = ? AND property_schema_id = ? AND idx = ?",
            (node_id, schema_id, index),
        ).fetchone()
        if row is None:
            return None
        return json.loads(row[0])

    def list_nodes(self) -> list[dict[str, Any]]:
        rows = self._conn.execute(
            "SELECT id, kind, parent_id, class_ids, content FROM node WHERE workspace_id = ?",
            (self._workspace_id,),
        ).fetchall()
        return [
            {
                "id": row[0],
                "kind": row[1],
                "parent_id": row[2],
                "class_ids": json.loads(row[3]),
                "content": json.loads(row[4]),
            }
            for row in rows
        ]

    def get_watermark(self) -> Hlc:
        return self._watermark
