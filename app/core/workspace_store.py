"""Server-side workspace store for the operation-log core.

``WorkspaceStore`` is scoped to a single workspace and actor. It encrypts
operations with the workspace master key, persists them through the relay
storage port, and applies them to a local SQLite derived-state database. This
lets backend feature islands participate in the same local-first operation log
as clients.
"""

from __future__ import annotations

import sqlite3
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from app.config import settings
from app.core.clock import Clock, Hlc
from app.core.crypto import (
    decrypt_operation_payload,
    encrypt_operation_payload,
)
from app.core.derived import apply_operation, create_derived_schema
from app.core.operation import Operation, OperationEnvelope
from app.core.uuid import uuidv7
from app.relay.key_storage import WorkspaceKeyStorage
from app.relay.models import EncryptedEnvelope
from app.relay.storage import RelayStorage, SqliteRelayStorage


class WorkspaceStore:
    """Server-side derived-state store scoped to ``(workspace_id, actor_id)``.

    Operations are encrypted with the workspace master key, saved to the relay,
    and applied to a per-workspace SQLite derived database. ``sync()`` replays
    operations from the relay into the derived database idempotently.
    """

    def __init__(
        self,
        workspace_id: str,
        actor_id: str,
        *,
        relay_storage: RelayStorage | None = None,
        db_path: str | None = None,
        key_storage: WorkspaceKeyStorage | None = None,
    ) -> None:
        self._workspace_id = workspace_id
        self._actor_id = actor_id
        self._key_storage = key_storage or WorkspaceKeyStorage()
        self._master_key: bytes | None = None

        if relay_storage is not None:
            self._relay_storage = relay_storage
        else:
            relay_db = settings.database_dir / "relay" / "relay.db"
            relay_db.parent.mkdir(parents=True, exist_ok=True)
            self._relay_storage = SqliteRelayStorage(relay_db)

        if db_path is not None:
            self._db_path = db_path
        else:
            self._db_path = str(
                settings.database_dir / "relay" / "derived" / f"{workspace_id}.db"
            )

        self._clock = Clock(device_id=actor_id)
        self._conn: sqlite3.Connection | None = None

    async def _ensure_connection(self) -> sqlite3.Connection:
        """Open the derived SQLite database and create the schema if needed."""
        if self._conn is None:
            if self._db_path == ":memory:":
                self._conn = sqlite3.connect(":memory:", check_same_thread=False)
            else:
                Path(self._db_path).parent.mkdir(parents=True, exist_ok=True)
                self._conn = sqlite3.connect(self._db_path, check_same_thread=False)
            self._conn.row_factory = sqlite3.Row
            create_derived_schema(self._conn)
            self._ensure_applied_table()
        return self._conn

    def _ensure_applied_table(self) -> None:
        """Create the idempotency table used by ``sync()``."""
        self._conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS applied_operation_id (
                id TEXT PRIMARY KEY
            );
            """
        )
        self._conn.commit()

    async def _get_master_key(self) -> bytes:
        """Return the workspace master key, fetching it once per instance."""
        if self._master_key is None:
            self._master_key = await self._key_storage.get_or_create_master_key(
                self._workspace_id, settings.secret_key
            )
        return self._master_key

    def _advance_clock(self) -> Hlc:
        """Generate the next HLC for a local operation."""
        return self._clock.advance(int(datetime.now(UTC).timestamp() * 1000))

    def _build_operation(
        self,
        op_type: str,
        payload: dict[str, Any],
        affected_node_ids: list[str] | None = None,
    ) -> Operation:
        """Build an :class:`Operation` with a fresh HLC and UUIDv7 id."""
        return Operation(
            envelope=OperationEnvelope(
                id=uuidv7(),
                workspace_id=self._workspace_id,
                actor_id=self._actor_id,
                hlc=self._advance_clock(),
                affected_node_ids=affected_node_ids or [],
                op_type=op_type,
            ),
            payload=payload,
        )

    async def apply(self, operation: Operation) -> None:
        """Encrypt, persist, and apply a single operation.

        Skips saving/applying when the operation id already exists in relay
        storage, making the method safely idempotent.
        """
        if self._relay_storage.envelope_exists(operation.id):
            return

        master_key = await self._get_master_key()
        encrypted = encrypt_operation_payload(operation.payload, master_key)
        envelope = EncryptedEnvelope(
            id=operation.id,
            workspace_id=operation.envelope.workspace_id,
            actor_id=operation.envelope.actor_id,
            hlc=operation.envelope.hlc,
            affected_node_ids=operation.envelope.affected_node_ids,
            op_type=operation.envelope.op_type,
            ciphertext=encrypted["ciphertext"],
            iv=encrypted["iv"],
            timestamp=operation.envelope.timestamp,
        )
        self._relay_storage.save_envelope(envelope)

        conn = await self._ensure_connection()
        apply_operation(conn, operation)
        conn.execute(
            "INSERT OR IGNORE INTO applied_operation_id (id) VALUES (?)",
            (operation.id,),
        )
        conn.commit()

    async def sync(self) -> None:
        """Fetch all operations from the relay and apply them idempotently.

        Decrypts each payload with the workspace master key and skips operations
        already recorded in the ``applied_operation_id`` table. This is important
        for increment-only appliers such as ``link.click``.
        """
        master_key = await self._get_master_key()
        envelopes = self._relay_storage.get_catch_up(
            self._workspace_id, Hlc(physical=0, logical=0)
        )
        conn = await self._ensure_connection()

        for envelope in envelopes:
            if self._is_applied(conn, envelope.id):
                continue

            payload = decrypt_operation_payload(
                envelope.ciphertext, envelope.iv, master_key
            )
            operation = Operation(
                envelope=OperationEnvelope(
                    id=envelope.id,
                    workspace_id=envelope.workspace_id,
                    actor_id=envelope.actor_id,
                    hlc=envelope.hlc,
                    affected_node_ids=envelope.affected_node_ids,
                    op_type=envelope.op_type,
                    timestamp=envelope.timestamp,
                ),
                payload=payload,
            )
            apply_operation(conn, operation)
            conn.execute(
                "INSERT OR IGNORE INTO applied_operation_id (id) VALUES (?)",
                (operation.id,),
            )

        conn.commit()

    def _is_applied(self, conn: sqlite3.Connection, operation_id: str) -> bool:
        row = conn.execute(
            "SELECT 1 FROM applied_operation_id WHERE id = ?", (operation_id,)
        ).fetchone()
        return row is not None

    async def create_node(
        self,
        node_id: str,
        kind: str,
        parent_id: str | None = None,
        index: int = 0,
        initial_content: list[dict[str, Any]] | None = None,
        class_ids: list[str] | None = None,
    ) -> None:
        """Emit a ``node.create`` operation."""
        payload: dict[str, Any] = {"nodeId": node_id, "kind": kind}
        if parent_id is not None:
            payload["parentId"] = parent_id
        if index != 0:
            payload["index"] = index
        if initial_content is not None:
            payload["initialContent"] = initial_content
        if class_ids is not None:
            payload["classIds"] = class_ids
        await self.apply(self._build_operation("node.create", payload, [node_id]))

    async def delete_node(self, node_id: str) -> None:
        """Emit a ``node.delete`` operation."""
        await self.apply(
            self._build_operation("node.delete", {"nodeId": node_id}, [node_id])
        )

    async def move_node(
        self,
        node_id: str,
        new_parent_id: str | None = None,
        new_index: int = 0,
    ) -> None:
        """Emit a ``node.move`` operation."""
        payload: dict[str, Any] = {"nodeId": node_id}
        if new_parent_id is not None:
            payload["newParentId"] = new_parent_id
        if new_index != 0:
            payload["newIndex"] = new_index
        await self.apply(self._build_operation("node.move", payload, [node_id]))

    async def assign_class(self, node_id: str, class_id: str) -> None:
        """Emit a ``class.assign`` operation."""
        await self.apply(
            self._build_operation(
                "class.assign",
                {"nodeId": node_id, "classId": class_id},
                [node_id, class_id],
            )
        )

    async def unassign_class(self, node_id: str, class_id: str) -> None:
        """Emit a ``class.unassign`` operation."""
        await self.apply(
            self._build_operation(
                "class.unassign",
                {"nodeId": node_id, "classId": class_id},
                [node_id, class_id],
            )
        )

    async def set_property(
        self,
        property_value_id: str,
        node_id: str,
        schema_id: str,
        value: Any,
        index: int = 0,
    ) -> None:
        """Emit a ``property.set`` operation."""
        payload: dict[str, Any] = {
            "propertyValueId": property_value_id,
            "nodeId": node_id,
            "schemaId": schema_id,
            "value": value,
        }
        if index != 0:
            payload["index"] = index
        await self.apply(self._build_operation("property.set", payload, [node_id]))

    async def unset_property(
        self,
        node_id: str,
        schema_id: str,
        index: int = 0,
    ) -> None:
        """Emit a ``property.unset`` operation."""
        payload: dict[str, Any] = {"nodeId": node_id, "schemaId": schema_id}
        if index != 0:
            payload["index"] = index
        await self.apply(self._build_operation("property.unset", payload, [node_id]))

    async def record_activity(
        self,
        activity_id: str,
        node_id: str,
        action: str,
        target_node_id: str | None = None,
        details: dict[str, Any] | None = None,
    ) -> None:
        """Emit an ``activity.record`` operation."""
        payload: dict[str, Any] = {
            "activityId": activity_id,
            "nodeId": node_id,
            "action": action,
        }
        if target_node_id is not None:
            payload["targetNodeId"] = target_node_id
        if details is not None:
            payload["details"] = details
        await self.apply(
            self._build_operation("activity.record", payload, [node_id])
        )

    async def record_link_click(
        self,
        source_node_id: str,
        target_node_id: str,
        clicked_at: str | None = None,
    ) -> None:
        """Emit a ``link.click`` operation."""
        payload: dict[str, Any] = {
            "sourceNodeId": source_node_id,
            "targetNodeId": target_node_id,
        }
        if clicked_at is not None:
            payload["clickedAt"] = clicked_at
        await self.apply(
            self._build_operation(
                "link.click", payload, [source_node_id, target_node_id]
            )
        )

    async def query(
        self,
        sql: str,
        parameters: tuple[Any, ...] | None = None,
    ) -> list[sqlite3.Row]:
        """Execute a read-only query against the derived SQLite database."""
        conn = await self._ensure_connection()
        cursor = conn.execute(sql, parameters or ())
        return list(cursor.fetchall())

    async def execute(
        self,
        sql: str,
        parameters: tuple[Any, ...] | None = None,
    ) -> None:
        """Execute a write statement against the derived SQLite database."""
        conn = await self._ensure_connection()
        conn.execute(sql, parameters or ())
        conn.commit()

    async def close(self) -> None:
        """Close the derived SQLite connection."""
        if self._conn is not None:
            self._conn.close()
            self._conn = None
