"""Server-side workspace store for the operation-log core.

``WorkspaceStore`` is scoped to a single workspace and actor. It persists
operations through the relay storage port and applies them to a local SQLite
derived-state database. This
lets backend feature islands participate in the same local-first operation log
as clients.
"""

from __future__ import annotations

import asyncio
import json
import sqlite3
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from app.config import settings
from app.core.clock import Clock, Hlc, compare_hlc
from app.core.derived import apply_operation, create_derived_schema
from app.core.derived.class_hierarchy import class_extends_would_cycle
from app.core.operation import Operation, OperationEnvelope
from app.core.uuid import uuidv7
from app.relay.key_storage import WorkspaceKeyStorage
from app.relay.models import RelayEnvelope
from app.relay.storage import RelayStorage

# Number of envelopes fetched and applied per batch during cold-sync catch-up.
# Kept below SQLite's default 999 bound-variable limit so the batched
# applied-id check works on any supported SQLite build.
_CATCH_UP_BATCH_SIZE = 500


class WorkspaceStore:
    """Server-side derived-state store scoped to ``(workspace_id, actor_id)``.

    Operations are saved to the relay as plaintext JSON payloads and applied to
    a per-workspace SQLite derived database. ``sync()`` replays
    operations from the relay into the derived database idempotently.
    """

    # Serialize sync() and apply()/apply_many() per workspace so concurrent
    # requests cannot interleave relay persistence with catch-up replay, which
    # would double-apply non-idempotent operations (e.g. ``link.click``).
    _sync_locks: dict[str, asyncio.Lock] = {}

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
        self.actor_id = actor_id
        self._key_storage = key_storage or WorkspaceKeyStorage()
        self._master_key: bytes | None = None

        if relay_storage is not None:
            self._relay_storage = relay_storage
            self._owns_relay_storage = False
        else:
            # Lazy import avoids a circular dependency between the workspace store
            # and relay dependency providers.
            from app.relay.dependencies import get_relay_storage

            self._relay_storage = get_relay_storage()
            self._owns_relay_storage = False

        if db_path is not None:
            self._db_path = db_path
        else:
            self._db_path = str(settings.database_dir / "relay" / "derived" / f"{workspace_id}.db")

        self._clock = Clock(device_id=actor_id)
        self._conn: sqlite3.Connection | None = None
        self._sync_lock = self._sync_locks.setdefault(workspace_id, asyncio.Lock())

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
            self._conn.deserialize(data)
        else:
            Path(self._db_path).parent.mkdir(parents=True, exist_ok=True)
            if Path(self._db_path).exists():
                Path(self._db_path).unlink()
            # ``sqlite3.Connection.deserialize`` loads the serialized bytes into
            # memory even when the connection is opened on a file path, leaving
            # the backing file empty. Restore into an in-memory connection and
            # then copy it to the target file with ``backup`` so subsequent
            # openings of the file path see the snapshot.
            mem_conn = sqlite3.connect(":memory:", check_same_thread=False)
            mem_conn.deserialize(data)
            self._conn = sqlite3.connect(self._db_path, check_same_thread=False)
            with self._conn:
                mem_conn.backup(self._conn)
            mem_conn.close()

        self._conn.row_factory = sqlite3.Row
        # Snapshots may have been generated by an older schema version. Run the
        # current schema creation script (CREATE TABLE IF NOT EXISTS / CREATE
        # INDEX IF NOT EXISTS) so any missing tables, columns, or indexes are
        # added before we continue applying operations.
        create_derived_schema(self._conn)
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

    async def apply(self, operation: Operation) -> RelayEnvelope | None:
        """Persist and apply a single operation.

        Skips saving/applying when the operation id already exists in relay
        storage, making the method safely idempotent.

        Persist and derived-state application hold the workspace sync lock so a
        concurrent ``sync()`` cannot fetch and replay the freshly persisted
        envelope before it is recorded in ``applied_operation_id`` (which would
        double-apply non-idempotent appliers). Plugin side effects run after
        the lock is released because handlers may emit follow-up operations on
        the same workspace through another store instance, and the lock is not
        reentrant.

        Returns:
            The relay envelope that was saved, or ``None`` when the
            operation was already present and was skipped.
        """
        async with self._sync_lock:
            envelope = await self._persist_operation(operation)
            if envelope is None:
                return None

            conn = await self._ensure_connection()
            self._apply_to_derived(conn, operation)
            conn.commit()
            self._clock.update(
                operation.envelope.hlc,
                int(datetime.now(UTC).timestamp() * 1000),
            )
        await self._invoke_class_side_effects(operation)
        return envelope

    async def apply_many(
        self, operations: list[Operation]
    ) -> list[RelayEnvelope | None]:
        """Persist and apply multiple operations.

        Operations whose ids already exist in relay storage are skipped. The
        remaining operations are persisted to the relay and applied to the
        derived SQLite database in a single transaction, with their ids
        recorded in ``applied_operation_id`` atomically.

        Returns:
            A list parallel to ``operations``: the relay envelope for each
            persisted operation, or ``None`` for operations that were skipped.
        """
        results: list[RelayEnvelope | None] = []
        to_apply: list[Operation] = []

        # Hold the workspace sync lock across persist + derived application so
        # a concurrent sync() cannot replay these envelopes in between. Plugin
        # side effects run after the lock is released (see apply()).
        async with self._sync_lock:
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
                self._clock.update(
                    operation.envelope.hlc,
                    int(datetime.now(UTC).timestamp() * 1000),
                )
        for operation in to_apply:
            await self._invoke_class_side_effects(operation)
        return results

    async def _persist_operation(
        self, operation: Operation
    ) -> RelayEnvelope | None:
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

        envelope = RelayEnvelope(
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
        restored from it and only operations past the snapshot's seq cursor are
        replayed. Otherwise all operations are replayed from seq zero.

        Skips operations already recorded in the ``applied_operation_id`` table.
        This is important for increment-only appliers such as ``link.click``.

        Sync is serialized per workspace so concurrent requests do not race
        while restoring the derived database from a snapshot.
        """
        async with self._sync_lock:
            snapshot = await self._maybe_await(
                self._relay_storage.get_latest_snapshot(self.workspace_id)
            )
            if snapshot is not None:
                conn = self._restore_from_snapshot(snapshot["data"])
                max_seen_hlc = snapshot["hlc"]
                # Snapshots recorded before the seq cursor existed fall back to
                # a full replay; the applied_operation_id dedupe (restored with
                # the snapshot) keeps already-applied operations from
                # re-applying.
                after_seq = snapshot["up_to_seq"] or 0
            else:
                conn = await self._ensure_connection()
                max_seen_hlc = Hlc(physical=0, logical=0)
                after_seq = 0

            # Page through the relay in batches instead of loading the full
            # operation history at once, and check already-applied ids with a
            # single query per batch rather than per envelope.
            while True:
                envelopes, next_after_seq = await self._maybe_await(
                    self._relay_storage.get_catch_up_paginated(
                        self.workspace_id,
                        after_seq,
                        limit=_CATCH_UP_BATCH_SIZE,
                    )
                )
                if not envelopes:
                    break

                applied_ids = self._applied_ids(conn, [envelope.id for envelope in envelopes])
                for envelope in envelopes:
                    if envelope.id in applied_ids:
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

                if next_after_seq is None:
                    break
                after_seq = next_after_seq

            self._clock.update(max_seen_hlc, int(datetime.now(UTC).timestamp() * 1000))
            conn.commit()

    def _applied_ids(self, conn: sqlite3.Connection, operation_ids: list[str]) -> set[str]:
        """Return the subset of ``operation_ids`` already recorded as applied."""
        if not operation_ids:
            return set()
        placeholders = ", ".join("?" for _ in operation_ids)
        rows = conn.execute(
            f"SELECT id FROM applied_operation_id WHERE id IN ({placeholders})",
            operation_ids,
        ).fetchall()
        return {row[0] for row in rows}

    async def get_envelopes(self, after_seq: int = 0) -> list[RelayEnvelope]:
        """Return persisted envelopes for this workspace past the ``after_seq`` cursor."""
        return await self._maybe_await(
            self._relay_storage.get_catch_up(self.workspace_id, after_seq)
        )

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
        snapshot_id, _up_to_seq = await self._maybe_await(
            self._relay_storage.create_snapshot(
                self.workspace_id, up_to_hlc, data=db_bytes
            )
        )
        return snapshot_id

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
        if kind == "class":
            raise ValueError(
                "kind='class' is no longer supported; use create_class() instead"
            )
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

    async def create_class(
        self,
        class_id: str,
        name: str,
        icon: str | None = None,
        color: str | None = None,
        extends_class_ids: list[str] | None = None,
    ) -> None:
        """Emit a ``class.create`` operation."""
        if extends_class_ids:
            await self._ensure_no_class_extends_cycle(class_id, extends_class_ids)
        payload: dict[str, Any] = {"classId": class_id, "name": name}
        if icon is not None:
            payload["icon"] = icon
        if color is not None:
            payload["color"] = color
        if extends_class_ids is not None:
            payload["extends"] = extends_class_ids
        await self.apply(self._build_operation("class.create", payload, [class_id]))

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

    async def update_class(
        self,
        class_id: str,
        name: str | None = None,
        icon: str | None = None,
        color: str | None = None,
        description: str | None = None,
    ) -> None:
        """Emit a ``class.update`` operation."""
        payload: dict[str, Any] = {"classId": class_id}
        if name is not None:
            payload["name"] = name
        if icon is not None:
            payload["icon"] = icon
        if color is not None:
            payload["color"] = color
        if description is not None:
            payload["description"] = description
        await self.apply(self._build_operation("class.update", payload, [class_id]))

    async def delete_class(self, class_id: str) -> None:
        """Emit a ``class.delete`` operation."""
        await self.apply(
            self._build_operation("class.delete", {"classId": class_id}, [class_id])
        )

    async def _ensure_no_class_extends_cycle(
        self,
        class_id: str,
        extends_class_ids: list[str],
    ) -> None:
        """Reject an extends change that would create an inheritance cycle."""
        conn = await self._ensure_connection()
        parent_id = class_extends_would_cycle(conn, class_id, extends_class_ids)
        if parent_id is not None:
            raise ValueError(
                f"Cannot set extends for class {class_id}: "
                f"{parent_id} would create an inheritance cycle"
            )

    async def set_class_extends(
        self,
        class_id: str,
        extends_class_ids: list[str],
    ) -> None:
        """Emit a ``class.setExtends`` operation."""
        await self._ensure_no_class_extends_cycle(class_id, extends_class_ids)
        await self.apply(
            self._build_operation(
                "class.setExtends",
                {"classId": class_id, "extendsClassIds": extends_class_ids},
                [class_id, *extends_class_ids],
            )
        )

    async def create_property_schema(
        self,
        schema_id: str,
        name: str,
        prop_type: str,
        *,
        icon: str | None = None,
        multi: bool = False,
        is_system: bool = False,
        scope: str | None = None,
        class_filter_uuids: list[str] | None = None,
        options: list[dict[str, Any]] | None = None,
        default_value: Any = None,
    ) -> None:
        """Emit a ``propertySchema.create`` operation."""
        payload: dict[str, Any] = {"schemaId": schema_id, "name": name, "type": prop_type}
        if icon is not None:
            payload["icon"] = icon
        if multi:
            payload["multi"] = True
        if is_system:
            payload["isSystem"] = True
        if scope is not None:
            payload["scope"] = scope
        if class_filter_uuids is not None:
            payload["classFilterUuids"] = class_filter_uuids
        if options is not None:
            payload["options"] = options
        if default_value is not None:
            payload["defaultValue"] = default_value
        await self.apply(
            self._build_operation(
                "propertySchema.create",
                payload,
                [schema_id],
            )
        )

    async def create_class_property_edge(
        self,
        class_id: str,
        property_schema_id: str,
        sequence: int = 0,
    ) -> None:
        """Emit a ``classPropertyEdge.create`` operation."""
        await self.apply(
            self._build_operation(
                "classPropertyEdge.create",
                {
                    "classId": class_id,
                    "propertySchemaId": property_schema_id,
                    "sequence": sequence,
                },
                [class_id, property_schema_id],
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

    async def delete_activity(self, activity_id: str, node_id: str) -> None:
        """Emit an ``activity.delete`` operation."""
        payload: dict[str, Any] = {"activityId": activity_id, "nodeId": node_id}
        await self.apply(self._build_operation("activity.delete", payload, [node_id]))

    async def record_link_click(
        self,
        source_node_id: str,
        target_node_id: str,
        clicked_at: str | None = None,
        link_uuid: str | None = None,
    ) -> None:
        """Emit a ``link.click`` operation."""
        payload: dict[str, Any] = {
            "sourceNodeId": source_node_id,
            "targetNodeId": target_node_id,
        }
        if clicked_at is not None:
            payload["clickedAt"] = clicked_at
        if link_uuid is not None:
            payload["linkUuid"] = link_uuid
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
    ) -> RelayEnvelope | None:
        """Emit a ``node.updateContent`` operation carrying a Yjs text update.

        The raw bytes are serialized as a list of ints so the payload remains
        JSON-serializable and matches the format expected by the frontend
        derived-state applier.

        Returns:
            The relay envelope that was saved, or ``None`` when the
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

    async def get_node(self, node_id: str) -> dict[str, Any] | None:
        """Return a single node from the derived database, or ``None``."""
        rows = await self.query(
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
        )
        if not rows:
            return None
        row = rows[0]
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

    async def list_nodes(self) -> list[dict[str, Any]]:
        """Return all nodes for this workspace from the derived database."""
        rows = await self.query(
            "SELECT id, kind, parent_id, class_ids, content FROM node WHERE workspace_id = ?",
            (self.workspace_id,),
        )
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

    async def get_children(self, parent_id: str) -> list[str]:
        """Return ordered child ids for ``parent_id``."""
        rows = await self.query(
            "SELECT child_id FROM node_child_order WHERE parent_id = ? ORDER BY position",
            (parent_id,),
        )
        return [row[0] for row in rows]

    async def get_property(
        self,
        *,
        node_id: str,
        schema_id: str,
        index: int = 0,
    ) -> Any | None:
        """Return the value of a property, or ``None`` if unset."""
        rows = await self.query(
            "SELECT value FROM property_value WHERE node_id = ? AND property_schema_id = ? AND idx = ?",
            (node_id, schema_id, index),
        )
        if not rows:
            return None
        return json.loads(rows[0][0])

    async def get_db(self) -> sqlite3.Connection:
        """Return the underlying derived SQLite connection."""
        return await self._ensure_connection()

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
