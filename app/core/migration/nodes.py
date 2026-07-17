"""Migrate nodes from the current PostgreSQL schema to ideal operations.

This module is intentionally focused on Phase 2.B1: structural node migration.
It reads the legacy ``node`` table and emits ``node.create``, ``node.move``,
``class.assign``, ``node.updateContent`` and ``node.delete`` operations.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any
from uuid import UUID

import asyncpg

from app.core.clock import Hlc
from app.core.migration.writer import OperationWriter
from app.core.operation import Operation, create_operation
from app.core.uuid import uuidv7

# Boolean node flags that map to system classes in the ideal architecture.
SYSTEM_CLASS_FLAGS: tuple[str, ...] = (
    "is_task",
    "is_template",
    "is_day",
    "is_month",
    "is_year",
    "is_asset",
    "is_table",
    "is_card",
    "is_cloze",
    "is_comment",
)

# Stable global UUIDs for legacy system classes. These IDs are reused across
# every workspace because the PostgreSQL schema stores system classes as fixed
# UUID rows (e.g. 00000000-0000-0000-0001-000000000012 for "task").
SYSTEM_CLASS_UUIDS: dict[str, str] = {
    "is_task": "00000000-0000-0000-0001-000000000012",
    "is_template": "00000000-0000-0000-0001-000000000013",
    "is_day": "00000000-0000-0000-0001-000000000005",
    "is_month": "00000000-0000-0000-0001-000000000004",
    "is_year": "00000000-0000-0000-0001-000000000003",
    "is_asset": "00000000-0000-0000-0001-000000000009",
    "is_table": "00000000-0000-0000-0001-000000000015",
    "is_card": "00000000-0000-0000-0001-000000000011",
    "is_cloze": "00000000-0000-0000-0001-000000000022",
    "is_comment": "00000000-0000-0000-0001-000000000014",
}


@dataclass
class MigrationContext:
    """Shared state while migrating a single workspace."""

    workspace_uuid: str
    actor_id: str
    system_class_ids: dict[str, str]
    id_map: dict[int, str]
    physical_time: int
    logical_counter: int = 0

    def next_hlc(self) -> Hlc:
        """Return the next HLC, incrementing the logical counter."""
        hlc = Hlc(physical=self.physical_time, logical=self.logical_counter)
        self.logical_counter += 1
        return hlc

    def map_node_id(self, old_id: int | None) -> str | None:
        """Map a legacy integer node id to its ideal UUID."""
        if old_id is None:
            return None
        if old_id not in self.id_map:
            self.id_map[old_id] = uuidv7()
        return self.id_map[old_id]


async def fetch_workspace_uuid(
    conn: asyncpg.Connection,
    workspace_int_id: int,
) -> str | None:
    """Return the workspace UUID string for the given legacy integer id."""
    row = await conn.fetchrow(
        "SELECT uuid FROM workspace WHERE id = $1",
        workspace_int_id,
    )
    if row is None:
        return None
    return str(row["uuid"])


async def fetch_nodes(
    conn: asyncpg.Connection,
    workspace_int_id: int,
    *,
    only_deleted: bool = False,
) -> list[asyncpg.Record]:
    """Fetch node rows for a workspace.

    By default only live (non-deleted) rows are returned. Pass
    ``only_deleted=True`` to fetch only soft-deleted rows.
    """
    query = """
        SELECT id, uuid, workspace_id, name, parent_id, sequence,
               is_deleted, deleted_at,
               is_class, is_page, is_day, is_month, is_year,
               is_asset, is_template, is_comment, is_task, is_table,
               is_card, is_cloze, class_ids
        FROM node
        WHERE workspace_id = $1
    """
    if only_deleted:
        query += " AND is_deleted = TRUE"
    else:
        query += " AND is_deleted = FALSE"
    query += " ORDER BY id"
    return await conn.fetch(query, workspace_int_id)


def _is_valid_uuid(value: Any) -> bool:
    """Return True if ``value`` is a valid UUID (object or string)."""
    if isinstance(value, UUID):
        return True
    if not isinstance(value, str):
        return False
    try:
        UUID(value)
    except ValueError:
        return False
    return True


def _build_id_map(nodes: list[asyncpg.Record]) -> dict[int, str]:
    """Map every legacy node id to a UUID, preserving valid existing UUIDs."""
    id_map: dict[int, str] = {}
    for row in nodes:
        old_id = row["id"]
        existing = row.get("uuid")
        if _is_valid_uuid(existing):
            id_map[old_id] = str(existing)
        else:
            id_map[old_id] = uuidv7()
    return id_map


def _node_kind(row: asyncpg.Record) -> str:
    """Derive the ideal node kind from legacy boolean flags."""
    if row["is_class"]:
        return "class"
    if row["is_page"] or row["is_day"] or row["is_month"] or row["is_year"] or row["is_template"]:
        return "page"
    return "block"


def _sequence_position(sequence: float | None) -> str:
    """Convert a legacy sequence value to a CRDT position string."""
    if sequence is None:
        return "0"
    return str(sequence)


def _system_class_ids(
    workspace_uuid: str,
    factory: Callable[[str], str] | None = None,
) -> dict[str, str]:
    """Return the stable UUID for each system class in the workspace.

    By default the global legacy system-class UUIDs are reused so that
    ``class.assign`` operations reference the same rows that already exist in
    PostgreSQL. Tests may pass a ``factory`` to override the IDs.
    """
    factory = factory or (lambda flag: SYSTEM_CLASS_UUIDS[flag])
    return {flag: factory(flag) for flag in SYSTEM_CLASS_FLAGS}


def _create_ops(ctx: MigrationContext, nodes: list[asyncpg.Record]) -> list[Operation]:
    """Emit ``node.create`` operations for every node (live or deleted)."""
    ops: list[Operation] = []
    for row in nodes:
        node_id = ctx.map_node_id(row["id"])
        if node_id is None:  # pragma: no cover - id_map always provides a value
            continue
        payload: dict[str, Any] = {
            "nodeId": node_id,
            "kind": _node_kind(row),
            "index": _sequence_position(row["sequence"]),
        }
        parent_id_int = row.get("parent_id")
        if parent_id_int is not None and parent_id_int in ctx.id_map:
            payload["parentId"] = ctx.id_map[parent_id_int]
        ops.append(
            create_operation(
                envelope={
                    "workspace_id": ctx.workspace_uuid,
                    "actor_id": ctx.actor_id,
                    "hlc": ctx.next_hlc(),
                    "affected_node_ids": [node_id],
                    "op_type": "node.create",
                },
                payload=payload,
            )
        )
    return ops


def _move_ops(ctx: MigrationContext, nodes: list[asyncpg.Record]) -> list[Operation]:
    """Emit ``node.move`` operations to reconstruct parent/child hierarchy."""
    ops: list[Operation] = []
    for row in nodes:
        node_id = ctx.map_node_id(row["id"])
        if node_id is None:
            continue
        parent_id_int = row.get("parent_id")
        if parent_id_int is None:
            continue
        # Skip dangling parent references; the node will become a root.
        if parent_id_int not in ctx.id_map:
            continue
        parent_id = ctx.id_map[parent_id_int]
        ops.append(
            create_operation(
                envelope={
                    "workspace_id": ctx.workspace_uuid,
                    "actor_id": ctx.actor_id,
                    "hlc": ctx.next_hlc(),
                    "affected_node_ids": [node_id, parent_id],
                    "op_type": "node.move",
                },
                payload={
                    "nodeId": node_id,
                    "newParentId": parent_id,
                    "newIndex": _sequence_position(row["sequence"]),
                },
            )
        )
    return ops


def _class_assign_ops(
    ctx: MigrationContext,
    nodes: list[asyncpg.Record],
) -> list[Operation]:
    """Emit ``class.assign`` operations for system classes and class_ids."""
    ops: list[Operation] = []
    for row in nodes:
        node_id = ctx.map_node_id(row["id"])
        if node_id is None:
            continue

        # Boolean flags → system classes.
        for flag in SYSTEM_CLASS_FLAGS:
            if row[flag]:
                class_id = ctx.system_class_ids[flag]
                ops.append(
                    create_operation(
                        envelope={
                            "workspace_id": ctx.workspace_uuid,
                            "actor_id": ctx.actor_id,
                            "hlc": ctx.next_hlc(),
                            "affected_node_ids": [node_id, class_id],
                            "op_type": "class.assign",
                        },
                        payload={"nodeId": node_id, "classId": class_id},
                    )
                )

        # Legacy class_ids array → class.assign for each referenced class node.
        class_ids = row.get("class_ids") or []
        for class_int_id in class_ids:
            class_id = ctx.map_node_id(class_int_id)
            if class_id is None:
                continue
            ops.append(
                create_operation(
                    envelope={
                        "workspace_id": ctx.workspace_uuid,
                        "actor_id": ctx.actor_id,
                        "hlc": ctx.next_hlc(),
                        "affected_node_ids": [node_id, class_id],
                        "op_type": "class.assign",
                    },
                    payload={"nodeId": node_id, "classId": class_id},
                )
            )
    return ops


def _update_content_ops(
    ctx: MigrationContext,
    nodes: list[asyncpg.Record],
) -> list[Operation]:
    """Emit ``node.updateContent`` operations for non-empty node names."""
    ops: list[Operation] = []
    for row in nodes:
        name = (row.get("name") or "").strip()
        if not name:
            continue
        node_id = ctx.map_node_id(row["id"])
        if node_id is None:
            continue
        ops.append(
            create_operation(
                envelope={
                    "workspace_id": ctx.workspace_uuid,
                    "actor_id": ctx.actor_id,
                    "hlc": ctx.next_hlc(),
                    "affected_node_ids": [node_id],
                    "op_type": "node.updateContent",
                },
                payload={
                    "nodeId": node_id,
                    "crdtUpdate": [{"type": "text", "text": name}],
                },
            )
        )
    return ops


def _delete_ops(
    ctx: MigrationContext,
    deleted_nodes: list[asyncpg.Record],
) -> list[Operation]:
    """Emit ``node.delete`` tombstones for soft-deleted rows."""
    ops: list[Operation] = []
    for row in deleted_nodes:
        node_id = ctx.map_node_id(row["id"])
        if node_id is None:
            continue
        ops.append(
            create_operation(
                envelope={
                    "workspace_id": ctx.workspace_uuid,
                    "actor_id": ctx.actor_id,
                    "hlc": ctx.next_hlc(),
                    "affected_node_ids": [node_id],
                    "op_type": "node.delete",
                },
                payload={"nodeId": node_id},
            )
        )
    return ops


async def create_migration_context(
    conn: asyncpg.Connection,
    workspace_int_id: int,
    actor_id: str,
    physical_time: int | None = None,
    class_id_factory: Callable[[str], str] | None = None,
) -> MigrationContext:
    """Build a shared migration context for a workspace.

    The context contains the workspace UUID, the HLC clock state, and the
    legacy-node-id -> ideal-UUID map. It can be passed to both node and
    property migration so that HLCs increase monotonically across both.
    """
    workspace_uuid = await fetch_workspace_uuid(conn, workspace_int_id)
    if not workspace_uuid:
        raise ValueError(f"Workspace {workspace_int_id} not found")

    if physical_time is None:
        physical_time = int(datetime.now(UTC).timestamp() * 1000)

    live_nodes = await fetch_nodes(conn, workspace_int_id)
    deleted_nodes = await fetch_nodes(conn, workspace_int_id, only_deleted=True)
    # The id map must cover deleted nodes too so that live class_ids references
    # to deleted classes still map to a stable UUID.
    id_map = _build_id_map(live_nodes + deleted_nodes)

    return MigrationContext(
        workspace_uuid=workspace_uuid,
        actor_id=actor_id,
        system_class_ids=_system_class_ids(workspace_uuid, factory=class_id_factory),
        id_map=id_map,
        physical_time=physical_time,
    )


async def migrate_nodes_for_workspace(
    conn: asyncpg.Connection,
    workspace_int_id: int,
    actor_id: str,
    writer: OperationWriter,
    physical_time: int | None = None,
    class_id_factory: Callable[[str], str] | None = None,
    ctx: MigrationContext | None = None,
) -> int:
    """Migrate one workspace's nodes into the target operation store.

    Args:
        conn: Asyncpg connection to the source PostgreSQL database.
        workspace_int_id: Legacy integer id of the workspace to migrate.
        actor_id: UUID of the migration actor.
        writer: Operation sink (SQLite file or in-memory collector).
        physical_time: Physical HLC component in milliseconds. Defaults to now.
        class_id_factory: Optional callable ``(flag_name) -> uuid`` used to make
            system-class IDs deterministic in tests.
        ctx: Optional shared migration context. When provided, HLC state and
            the node id map are reused (e.g. for property migration that runs
            after nodes).

    Returns:
        Number of operations written.
    """
    if ctx is None:
        ctx = await create_migration_context(
            conn, workspace_int_id, actor_id, physical_time, class_id_factory
        )

    live_nodes = await fetch_nodes(conn, workspace_int_id)
    deleted_nodes = await fetch_nodes(conn, workspace_int_id, only_deleted=True)
    # Ensure the context map covers any nodes discovered now (it normally will).
    ctx.id_map.update(_build_id_map(live_nodes + deleted_nodes))

    operations: list[Operation] = []
    operations.extend(_create_ops(ctx, live_nodes))
    operations.extend(_create_ops(ctx, deleted_nodes))
    operations.extend(_move_ops(ctx, live_nodes))
    operations.extend(_class_assign_ops(ctx, live_nodes))
    operations.extend(_update_content_ops(ctx, live_nodes))
    operations.extend(_delete_ops(ctx, deleted_nodes))

    for operation in operations:
        writer.write_operation(operation)

    return len(operations)
