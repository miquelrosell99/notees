"""Server-side workspace store for the operation-log core.

``WorkspaceStore`` is scoped to a single workspace and actor. It encrypts
operations with the workspace master key, persists them through the relay
storage port, and applies them to a local SQLite derived-state database. This
lets backend feature islands participate in the same local-first operation log
as clients.
"""

from __future__ import annotations

import asyncio
import sqlite3
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from app.config import settings
from app.core.clock import Clock, Hlc, compare_hlc
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
        self.workspace_id = workspace_id
        self._actor_id = actor_id
        self._key_storage = key_storage or WorkspaceKeyStorage()
        self._master_key: bytes | None = None

        if relay_storage is not None:
            self._relay_storage = relay_storage
            self._owns_relay_storage = False
        else:
            relay_db = settings.database_dir / "relay" / "relay.db"
            relay_db.parent.mkdir(parents=True, exist_ok=True)
            self._relay_storage = SqliteRelayStorage(relay_db)
            self._owns_relay_storage = True

        if db_path is not None:
            self._db_path = db_path
        else:
            self._db_path = str(settings.database_dir / "relay" / "derived" / f"{workspace_id}.db")

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

    def _restore_from_snapshot(self, data: bytes) -> sqlite3.Connection:
        """Replace the derived database with a serialized snapshot.

        The snapshot bytes are produced by ``sqlite3.Connection.serialize`` and
        include both the derived schema and the ``applied_operation_id`` table,
        so operations covered by the snapshot are already considered applied.
        """
        if self._conn is not None:
            self._conn.close()
            self._conn = None

        if self._db_path == ":memory:":
            self._conn = sqlite3.connect(":memory:", check_same_thread=False)
        else:
            Path(self._db_path).parent.mkdir(parents=True, exist_ok=True)
            if Path(self._db_path).exists():
                Path(self._db_path).unlink()
            self._conn = sqlite3.connect(self._db_path, check_same_thread=False)

        self._conn.row_factory = sqlite3.Row
        self._conn.deserialize(data)
        self._ensure_applied_table()
        self._conn.commit()
        return self._conn

    async def _get_master_key(self) -> bytes:
        """Return the workspace master key, fetching it once per instance."""
        if self._master_key is None:
            self._master_key = await self._key_storage.get_or_create_master_key(self.workspace_id, settings.secret_key)
        return self._master_key

    def _advance_clock(self) -> Hlc:
        """Generate the next HLC for a local operation."""
        return self._clock.advance(int(datetime.now(UTC).timestamp() * 1000))

    async def _maybe_await(self, value: Any) -> Any:
        """Await coroutine results from async storage adapters transparently.

        ``PostgresRelayStorage`` returns coroutines from its port methods, while
        ``SqliteRelayStorage`` returns plain values. This helper lets the store
        work with either adapter without forcing every caller to know which one
        is configured.
        """
        if asyncio.iscoroutine(value):
            return await value
        return value

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
                workspace_id=self.workspace_id,
                actor_id=self._actor_id,
                hlc=self._advance_clock(),
                affected_node_ids=affected_node_ids or [],
                op_type=op_type,
            ),
            payload=payload,
        )

    async def apply(self, operation: Operation) -> EncryptedEnvelope | None:
        """Encrypt, persist, and apply a single operation.

        Skips saving/applying when the operation id already exists in relay
        storage, making the method safely idempotent.

        Returns:
            The encrypted envelope that was saved, or ``None`` when the
            operation was already present and was skipped.
        """
        envelope = await self._persist_operation(operation)
        if envelope is None:
            return None

        conn = await self._ensure_connection()
        self._apply_to_derived(conn, operation)
        conn.commit()
        await self._invoke_class_side_effects(operation)
        return envelope

    async def apply_many(
        self, operations: list[Operation]
    ) -> list[EncryptedEnvelope | None]:
        """Encrypt, persist, and apply multiple operations.

        Operations whose ids already exist in relay storage are skipped. The
        remaining operations are persisted to the relay and applied to the
        derived SQLite database in a single transaction, with their ids
        recorded in ``applied_operation_id`` atomically.

        Returns:
            A list parallel to ``operations``: the encrypted envelope for each
            persisted operation, or ``None`` for operations that were skipped.
        """
        results: list[EncryptedEnvelope | None] = []
        to_apply: list[Operation] = []

        for operation in operations:
            envelope = await self._persist_operation(operation)
            results.append(envelope)
            if envelope is not None:
                to_apply.append(operation)

        if not to_apply:
            return results

        conn = await self._ensure_connection()
        for operation in to_apply:
            self._apply_to_derived(conn, operation)
        conn.commit()
        for operation in to_apply:
            await self._invoke_class_side_effects(operation)
        return results

    async def _persist_operation(
        self, operation: Operation
    ) -> EncryptedEnvelope | None:
        """Persist an operation to relay storage.

        Returns:
            The envelope that was saved, or ``None`` when an envelope with the
            same id was already present.
        """
        exists = await self._maybe_await(
            self._relay_storage.envelope_exists(operation.id)
        )
        if exists:
            return None

        envelope = EncryptedEnvelope(
            id=operation.id,
            workspace_id=operation.envelope.workspace_id,
            actor_id=operation.envelope.actor_id,
            hlc=operation.envelope.hlc,
            affected_node_ids=operation.envelope.affected_node_ids,
            op_type=operation.envelope.op_type,
            payload=operation.payload,
            timestamp=operation.envelope.timestamp,
        )
        await self._maybe_await(self._relay_storage.save_envelope(envelope))
        return envelope

    def _apply_to_derived(
        self, conn: sqlite3.Connection, operation: Operation
    ) -> None:
        """Apply an operation to the derived database and record its id."""
        apply_operation(conn, operation)
        conn.execute(
            "INSERT OR IGNORE INTO applied_operation_id (id) VALUES (?)",
            (operation.id,),
        )

    async def _invoke_class_side_effects(self, operation: Operation) -> None:
        """Notify registered plugins after ``class.assign`` / ``class.unassign``."""
        op_type = operation.envelope.op_type
        if op_type not in ("class.assign", "class.unassign"):
            return

        class_id = operation.payload.get("classId")
        node_id = operation.payload.get("nodeId")
        if not class_id or not node_id:
            return

        from app.core.derived.class_side_effects import get as get_class_side_effects

        added = op_type == "class.assign"
        for handler in get_class_side_effects(class_id):
            await handler(
                node_id,
                class_id,
                operation.envelope.workspace_id,
                operation.envelope.actor_id,
                added,
            )

    async def sync(self) -> None:
        """Fetch operations from the relay and apply them idempotently.

        If a snapshot exists for the workspace, the derived SQLite database is
        restored from it and only operations newer than the snapshot's HLC are
        replayed. Otherwise all operations are replayed from HLC zero.

        Skips operations already recorded in the ``applied_operation_id`` table.
        This is important for increment-only appliers such as ``link.click``.
        """
        snapshot = await self._maybe_await(
            self._relay_storage.get_latest_snapshot(self.workspace_id)
        )
        if snapshot is not None:
            conn = self._restore_from_snapshot(snapshot["data"])
            catch_up_hlc = snapshot["hlc"]
        else:
            conn = await self._ensure_connection()
            catch_up_hlc = Hlc(physical=0, logical=0)

        envelopes = await self._maybe_await(
            self._relay_storage.get_catch_up(self.workspace_id, catch_up_hlc)
        )
        max_seen_hlc = catch_up_hlc

        for envelope in envelopes:
            if self._is_applied(conn, envelope.id):
                continue

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
                payload=envelope.payload,
            )
            apply_operation(conn, operation)
            conn.execute(
                "INSERT OR IGNORE INTO applied_operation_id (id) VALUES (?)",
                (operation.id,),
            )
            if compare_hlc(envelope.hlc, max_seen_hlc) > 0:
                max_seen_hlc = envelope.hlc

        self._clock.update(max_seen_hlc, int(datetime.now(UTC).timestamp() * 1000))
        conn.commit()

    def _is_applied(self, conn: sqlite3.Connection, operation_id: str) -> bool:
        row = conn.execute("SELECT 1 FROM applied_operation_id WHERE id = ?", (operation_id,)).fetchone()
        return row is not None

    async def create_snapshot(self, up_to_hlc: Hlc | None = None) -> str:
        """Serialize the derived database and persist it as a relay snapshot.

        The store is synchronized first so the snapshot covers all operations
        currently in the relay. The snapshot's ``up_to_hlc`` defaults to the
        highest relay envelope HLC for the workspace.

        Returns:
            The new snapshot id.
        """
        await self.sync()
        conn = await self._ensure_connection()
        db_bytes = conn.serialize(name="main")
        if up_to_hlc is None:
            up_to_hlc = await self._maybe_await(
                self._relay_storage.get_max_hlc(self.workspace_id)
            )
        return await self._maybe_await(
            self._relay_storage.create_snapshot(
                self.workspace_id, up_to_hlc, data=db_bytes
            )
        )

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
        await self.apply(self._build_operation("node.delete", {"nodeId": node_id}, [node_id]))

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

    async def create_class(
        self,
        class_id: str,
        name: str,
        extends: list[str] | None = None,
    ) -> None:
        """Emit a ``class.create`` operation."""
        payload: dict[str, Any] = {"classId": class_id, "name": name}
        if extends is not None:
            payload["extends"] = extends
        await self.apply(self._build_operation("class.create", payload, [class_id]))

    async def create_property_schema(
        self,
        schema_id: str,
        name: str,
        prop_type: str,
    ) -> None:
        """Emit a ``propertySchema.create`` operation."""
        await self.apply(
            self._build_operation(
                "propertySchema.create",
                {"schemaId": schema_id, "name": name, "type": prop_type},
                [schema_id],
            )
        )

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
        await self.apply(self._build_operation("activity.record", payload, [node_id]))

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
        await self.apply(self._build_operation("link.click", payload, [source_node_id, target_node_id]))

    async def update_content(
        self,
        node_id: str,
        content: list[dict[str, Any]],
    ) -> None:
        """Emit a ``node.updateContent`` operation.

        The backend derived-state applier accepts a simplified content AST under
        ``crdtUpdate`` during the migration, so this helper forwards the AST in
        that shape.
        """
        await self.apply(
            self._build_operation(
                "node.updateContent",
                {"nodeId": node_id, "crdtUpdate": content},
                [node_id],
            )
        )

    async def update_text_crdt(
        self,
        node_id: str,
        update: bytes,
    ) -> EncryptedEnvelope | None:
        """Emit a ``node.updateContent`` operation carrying a Yjs text update.

        The raw bytes are serialized as a list of ints so the payload remains
        JSON-serializable and matches the format expected by the frontend
        derived-state applier.

        Returns:
            The encrypted envelope that was saved, or ``None`` when the
            operation was a duplicate.
        """
        return await self.apply(
            self._build_operation(
                "node.updateContent",
                {"nodeId": node_id, "textUpdate": list(update)},
                [node_id],
            )
        )

    async def record_task_completion(
        self,
        completion_id: str,
        node_id: str,
        completed_at: str | None = None,
        completed_by: str | None = None,
        scheduled_date: str | None = None,
        deadline_date: str | None = None,
        status: str = "done",
    ) -> None:
        """Emit a ``task.recordCompletion`` operation."""
        payload: dict[str, Any] = {
            "completionId": completion_id,
            "nodeId": node_id,
            "status": status,
        }
        if completed_at is not None:
            payload["completedAt"] = completed_at
        if completed_by is not None:
            payload["completedBy"] = completed_by
        if scheduled_date is not None:
            payload["scheduledDate"] = scheduled_date
        if deadline_date is not None:
            payload["deadlineDate"] = deadline_date
        await self.apply(self._build_operation("task.recordCompletion", payload, [node_id]))

    async def delete_task_completion(
        self,
        completion_id: str,
        node_id: str,
    ) -> None:
        """Emit a ``task.deleteCompletion`` operation."""
        await self.apply(
            self._build_operation(
                "task.deleteCompletion",
                {"completionId": completion_id, "nodeId": node_id},
                [node_id],
            )
        )

    async def set_task_recurrence(
        self,
        recurrence_id: str,
        node_id: str,
        rule: dict[str, Any],
    ) -> None:
        """Emit a ``task.setRecurrence`` operation."""
        await self.apply(
            self._build_operation(
                "task.setRecurrence",
                {"recurrenceId": recurrence_id, "nodeId": node_id, "rule": rule},
                [node_id],
            )
        )

    async def delete_task_recurrence(
        self,
        recurrence_id: str,
        node_id: str,
    ) -> None:
        """Emit a ``task.deleteRecurrence`` operation."""
        await self.apply(
            self._build_operation(
                "task.deleteRecurrence",
                {"recurrenceId": recurrence_id, "nodeId": node_id},
                [node_id],
            )
        )

    async def upload_asset(
        self,
        asset_id: str,
        node_id: str,
        file_hash: str,
        mime_type: str,
        size: int,
        original_name: str,
    ) -> None:
        """Emit an ``asset.upload`` operation."""
        await self.apply(
            self._build_operation(
                "asset.upload",
                {
                    "assetId": asset_id,
                    "nodeId": node_id,
                    "assetHash": file_hash,
                    "mimeType": mime_type,
                    "sizeBytes": size,
                    "originalName": original_name,
                },
                [node_id],
            )
        )

    async def delete_asset(self, asset_id: str, node_id: str) -> None:
        """Emit an ``asset.delete`` operation."""
        await self.apply(
            self._build_operation(
                "asset.delete",
                {"assetId": asset_id, "nodeId": node_id},
                [node_id],
            )
        )

    async def create_public_share(
        self,
        share_id: str,
        node_uuid: str,
        slug: str,
        password_hash: str | None = None,
        expiry_date: str | None = None,
    ) -> None:
        """Emit a ``share.public.create`` operation."""
        payload: dict[str, Any] = {
            "shareId": share_id,
            "nodeId": node_uuid,
            "slug": slug,
        }
        if password_hash is not None:
            payload["passwordHash"] = password_hash
        if expiry_date is not None:
            payload["expiryDate"] = expiry_date
        await self.apply(self._build_operation("share.public.create", payload, [node_uuid]))

    async def revoke_public_share(self, share_id: str, node_uuid: str | None = None) -> None:
        """Emit a ``share.public.revoke`` operation."""
        payload: dict[str, Any] = {"shareId": share_id}
        affected_nodes: list[str] = []
        if node_uuid is not None:
            payload["nodeId"] = node_uuid
            affected_nodes.append(node_uuid)
        await self.apply(self._build_operation("share.public.revoke", payload, affected_nodes))

    async def grant_user_share(
        self,
        share_id: str,
        node_uuid: str,
        user_id: str,
        permission: str,
    ) -> None:
        """Emit a ``share.user.grant`` operation.

        ``permission`` is encoded as a bitmask: read = 1, write = 2, create = 4,
        delete = 8. ``read`` maps to bit 1; ``write`` maps to read + write +
        create (bits 1|2|4 = 7) to match the legacy repository semantics where
        write implies create.
        """
        permission_bits = self._encode_share_permission_bits(permission)
        await self.apply(
            self._build_operation(
                "share.user.grant",
                {
                    "shareId": share_id,
                    "nodeId": node_uuid,
                    "targetUserId": user_id,
                    "permissionBits": permission_bits,
                },
                [node_uuid, user_id],
            )
        )

    @staticmethod
    def _encode_share_permission_bits(permission: str) -> int:
        """Encode a share permission string into a bitmask."""
        bits = 0
        norm = permission.lower().strip()
        if norm in {"read", "r"}:
            bits |= 1
        elif norm in {"write", "w"}:
            bits |= 1 | 2 | 4
        return bits

    async def revoke_user_share(
        self,
        share_id: str,
        node_uuid: str | None = None,
        user_id: str | None = None,
    ) -> None:
        """Emit a ``share.user.revoke`` operation."""
        payload: dict[str, Any] = {"shareId": share_id}
        affected_nodes: list[str] = []
        if node_uuid is not None:
            payload["nodeId"] = node_uuid
            affected_nodes.append(node_uuid)
        if user_id is not None:
            payload["targetUserId"] = user_id
            affected_nodes.append(user_id)
        await self.apply(self._build_operation("share.user.revoke", payload, affected_nodes))

    async def plugin_op(
        self,
        plugin_id: str,
        op_type: str,
        data: dict[str, Any],
        node_id: str | None = None,
    ) -> None:
        """Emit a ``plugin.op`` operation.

        If ``node_id`` is provided it is included in the payload and in the
        operation's affected-node list so the relay can route the operation.
        """
        payload: dict[str, Any] = {"pluginId": plugin_id, "opType": op_type, "data": data}
        if node_id is not None:
            payload["nodeId"] = node_id
        affected = [node_id] if node_id is not None else []
        await self.apply(self._build_operation("plugin.op", payload, affected))

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
    ) -> int:
        """Execute a write statement against the derived SQLite database.

        Returns:
            The number of rows affected by the statement.
        """
        conn = await self._ensure_connection()
        cursor = conn.execute(sql, parameters or ())
        conn.commit()
        return cursor.rowcount

    async def close(self) -> None:
        """Close the derived SQLite connection and owned relay storage adapter.

        Relay storage passed in by callers is not closed so it can be reused
        across multiple WorkspaceStore instances (e.g. writer/reader pairs in
        tests and snapshots).
        """
        if self._conn is not None:
            self._conn.close()
            self._conn = None
        if self._owns_relay_storage:
            await self._maybe_await(self._relay_storage.close())
