"""Unit tests for the node migration path."""

from __future__ import annotations

import sqlite3
from typing import Any
from uuid import uuid4

import pytest

from app.core.clock import Hlc
from app.core.migration.nodes import (
    SYSTEM_CLASS_FLAGS,
    migrate_nodes_for_workspace,
)
from app.core.migration.writer import InMemoryOperationWriter, SqliteOperationWriter
from app.core.operation import Operation, create_operation


class _FakeRecord:
    """Minimal asyncpg.Record stand-in."""

    def __init__(self, data: dict[str, Any]) -> None:
        self._data = data

    def __getitem__(self, key: str) -> Any:
        return self._data[key]

    def get(self, key: str, default: Any = None) -> Any:
        return self._data.get(key, default)


class _FakeConnection:
    """In-memory asyncpg connection used for migration tests."""

    def __init__(self, nodes: list[dict[str, Any]], workspace_uuid: str) -> None:
        self._nodes = [_FakeRecord(n) for n in nodes]
        self._workspace_uuid = workspace_uuid

    async def fetch(self, query: str, *args: Any) -> list[_FakeRecord]:
        workspace_id = args[0] if args else None
        only_live = "is_deleted = FALSE" in query
        only_deleted = "is_deleted = TRUE" in query
        result: list[_FakeRecord] = []
        for record in self._nodes:
            if record["workspace_id"] != workspace_id:
                continue
            if only_live and record["is_deleted"]:
                continue
            if only_deleted and not record["is_deleted"]:
                continue
            result.append(record)
        return result

    async def fetchrow(self, query: str, *args: Any) -> _FakeRecord | None:
        if "workspace" in query.lower():
            return _FakeRecord({"uuid": self._workspace_uuid})
        return None

    async def close(self) -> None:
        pass


_MISSING_UUID = object()


def _base_node(
    node_id: int,
    workspace_id: int = 1,
    *,
    name: str = "Node",
    uuid: str | object = _MISSING_UUID,
    parent_id: int | None = None,
    sequence: float = 0.0,
    is_deleted: bool = False,
    class_ids: list[int] | None = None,
    **flags: bool,
) -> dict[str, Any]:
    """Build a minimal legacy node row."""
    node_uuid = str(uuid4()) if uuid is _MISSING_UUID else uuid
    row: dict[str, Any] = {
        "id": node_id,
        "uuid": node_uuid,
        "workspace_id": workspace_id,
        "name": name,
        "parent_id": parent_id,
        "sequence": sequence,
        "is_deleted": is_deleted,
        "deleted_at": None,
        "is_class": False,
        "is_page": False,
        "is_day": False,
        "is_month": False,
        "is_year": False,
        "is_asset": False,
        "is_template": False,
        "is_comment": False,
        "is_task": False,
        "is_table": False,
        "is_card": False,
        "is_cloze": False,
        "class_ids": class_ids or [],
    }
    row.update(flags)
    return row


def _find_ops(ops: list[Operation], op_type: str) -> list[Operation]:
    return [op for op in ops if op.envelope.op_type == op_type]


def _ids_in_payloads(ops: list[Operation]) -> set[str]:
    """Collect every string value that looks like an id inside payloads."""
    ids: set[str] = set()
    for op in ops:
        for value in op.payload.values():
            if isinstance(value, str):
                ids.add(value)
    return ids


@pytest.mark.unit
async def test_maps_node_kinds() -> None:
    workspace_uuid = str(uuid4())
    nodes = [
        _base_node(1, name="Class node", is_class=True),
        _base_node(2, name="Page node", is_page=True),
        _base_node(3, name="Daily page", is_day=True),
        _base_node(4, name="Template", is_template=True),
        _base_node(5, name="Block", parent_id=2),
    ]
    conn = _FakeConnection(nodes, workspace_uuid)
    writer = InMemoryOperationWriter()

    await migrate_nodes_for_workspace(
        conn, 1, "actor-1", writer, physical_time=1_000
    )

    creates = _find_ops(writer.operations, "node.create")
    kinds = {op.payload["nodeId"]: op.payload["kind"] for op in creates}
    ids = list(kinds.keys())
    assert kinds[ids[0]] == "class"
    assert kinds[ids[1]] == "page"
    assert kinds[ids[2]] == "page"
    assert kinds[ids[3]] == "page"
    assert kinds[ids[4]] == "block"


@pytest.mark.unit
async def test_preserves_valid_uuids_and_generates_uuidv7() -> None:
    workspace_uuid = str(uuid4())
    valid_uuid = str(uuid4())
    nodes = [
        _base_node(1, uuid=valid_uuid),
        _base_node(2, uuid="not-a-uuid"),
        _base_node(3, uuid=""),
    ]
    conn = _FakeConnection(nodes, workspace_uuid)
    writer = InMemoryOperationWriter()

    await migrate_nodes_for_workspace(
        conn, 1, "actor-1", writer, physical_time=1_000
    )

    creates = _find_ops(writer.operations, "node.create")
    ids = [op.payload["nodeId"] for op in creates]
    assert ids[0] == valid_uuid
    # Generated ids are UUIDv7: 36 chars, version nibble == 7.
    for generated in ids[1:]:
        assert len(generated) == 36
        assert generated[14] == "7"


@pytest.mark.unit
async def test_generates_move_for_parented_nodes() -> None:
    workspace_uuid = str(uuid4())
    nodes = [
        _base_node(1, name="Parent page", is_page=True),
        _base_node(2, name="Child block", parent_id=1, sequence=1.5),
    ]
    conn = _FakeConnection(nodes, workspace_uuid)
    writer = InMemoryOperationWriter()

    await migrate_nodes_for_workspace(
        conn, 1, "actor-1", writer, physical_time=1_000
    )

    moves = _find_ops(writer.operations, "node.move")
    assert len(moves) == 1
    payload = moves[0].payload
    assert payload["newIndex"] == "1.5"


@pytest.mark.unit
async def test_skips_move_for_root_nodes() -> None:
    workspace_uuid = str(uuid4())
    nodes = [_base_node(1, name="Root page", is_page=True)]
    conn = _FakeConnection(nodes, workspace_uuid)
    writer = InMemoryOperationWriter()

    await migrate_nodes_for_workspace(
        conn, 1, "actor-1", writer, physical_time=1_000
    )

    assert not _find_ops(writer.operations, "node.move")


@pytest.mark.unit
async def test_class_assign_for_system_flags() -> None:
    workspace_uuid = str(uuid4())
    fixed_class_ids = {flag: f"class-{flag}" for flag in SYSTEM_CLASS_FLAGS}
    nodes = [_base_node(1, name="Task", is_task=True, is_template=True)]
    conn = _FakeConnection(nodes, workspace_uuid)
    writer = InMemoryOperationWriter()

    await migrate_nodes_for_workspace(
        conn,
        1,
        "actor-1",
        writer,
        physical_time=1_000,
        class_id_factory=lambda flag: fixed_class_ids[flag],
    )

    assigns = _find_ops(writer.operations, "class.assign")
    assigned = {op.payload["classId"] for op in assigns}
    assert fixed_class_ids["is_task"] in assigned
    assert fixed_class_ids["is_template"] in assigned


@pytest.mark.unit
async def test_class_assign_for_legacy_class_ids() -> None:
    workspace_uuid = str(uuid4())
    class_uuid = str(uuid4())
    nodes = [
        _base_node(10, uuid=class_uuid, name="MyClass", is_class=True),
        _base_node(20, name="Instance", class_ids=[10]),
    ]
    conn = _FakeConnection(nodes, workspace_uuid)
    writer = InMemoryOperationWriter()

    await migrate_nodes_for_workspace(
        conn, 1, "actor-1", writer, physical_time=1_000
    )

    assigns = _find_ops(writer.operations, "class.assign")
    instance_assigns = [
        op for op in assigns if op.payload["nodeId"] != class_uuid
    ]
    assert len(instance_assigns) == 1
    assert instance_assigns[0].payload["classId"] == class_uuid


@pytest.mark.unit
async def test_update_content_ast() -> None:
    workspace_uuid = str(uuid4())
    nodes = [_base_node(1, name="  Hello world  ")]
    conn = _FakeConnection(nodes, workspace_uuid)
    writer = InMemoryOperationWriter()

    await migrate_nodes_for_workspace(
        conn, 1, "actor-1", writer, physical_time=1_000
    )

    updates = _find_ops(writer.operations, "node.updateContent")
    assert len(updates) == 1
    assert updates[0].payload["crdtUpdate"] == [{"type": "text", "text": "Hello world"}]


@pytest.mark.unit
async def test_skips_update_content_for_empty_name() -> None:
    workspace_uuid = str(uuid4())
    nodes = [_base_node(1, name="   ")]
    conn = _FakeConnection(nodes, workspace_uuid)
    writer = InMemoryOperationWriter()

    await migrate_nodes_for_workspace(
        conn, 1, "actor-1", writer, physical_time=1_000
    )

    assert not _find_ops(writer.operations, "node.updateContent")


@pytest.mark.unit
async def test_soft_deleted_nodes_emit_delete_tombstones() -> None:
    workspace_uuid = str(uuid4())
    deleted_uuid = str(uuid4())
    nodes = [
        _base_node(1, name="Live"),
        _base_node(
            2, uuid=deleted_uuid, name="Gone", is_deleted=True, deleted_at="2026-01-01"
        ),
    ]
    conn = _FakeConnection(nodes, workspace_uuid)
    writer = InMemoryOperationWriter()

    await migrate_nodes_for_workspace(
        conn, 1, "actor-1", writer, physical_time=1_000
    )

    creates = _find_ops(writer.operations, "node.create")
    deletes = _find_ops(writer.operations, "node.delete")
    # Deleted-only nodes are created first (so downstream references are valid)
    # and then deleted.
    assert len(creates) == 2
    assert len(deletes) == 1
    assert deletes[0].payload["nodeId"] == deleted_uuid


@pytest.mark.unit
async def test_hlc_components_increase_monotonically() -> None:
    workspace_uuid = str(uuid4())
    nodes = [_base_node(i, name=f"N{i}") for i in range(1, 6)]
    conn = _FakeConnection(nodes, workspace_uuid)
    writer = InMemoryOperationWriter()

    await migrate_nodes_for_workspace(
        conn, 1, "actor-1", writer, physical_time=5_000
    )

    physical = writer.operations[0].envelope.hlc.physical
    for idx, op in enumerate(writer.operations):
        assert op.envelope.hlc.physical == physical
        assert op.envelope.hlc.logical == idx


@pytest.mark.unit
async def test_no_integer_ids_in_operations() -> None:
    workspace_uuid = str(uuid4())
    nodes = [
        _base_node(1, name="Parent", is_page=True),
        _base_node(2, name="Child", parent_id=1, class_ids=[1]),
    ]
    conn = _FakeConnection(nodes, workspace_uuid)
    writer = InMemoryOperationWriter()

    await migrate_nodes_for_workspace(
        conn, 1, "actor-1", writer, physical_time=1_000
    )

    for op in writer.operations:
        for value in op.payload.values():
            if isinstance(value, str):
                assert not value.isdigit(), f"integer id leaked: {value}"
        for value in op.envelope.affected_node_ids:
            assert not value.isdigit(), f"integer id leaked in affected ids: {value}"


@pytest.mark.unit
async def test_workspace_not_found_raises() -> None:
    class EmptyConnection(_FakeConnection):
        async def fetchrow(self, query: str, *args: Any) -> _FakeRecord | None:
            return None

    conn = EmptyConnection([], str(uuid4()))
    writer = InMemoryOperationWriter()

    with pytest.raises(ValueError, match="Workspace 99 not found"):
        await migrate_nodes_for_workspace(
            conn, 99, "actor-1", writer, physical_time=1_000
        )


@pytest.mark.unit
async def test_sqlite_writer_roundtrip(tmp_path: Any) -> None:
    path = tmp_path / "migration.sqlite"
    writer = SqliteOperationWriter(path)
    op = create_operation(
        envelope={
            "workspace_id": "ws-1",
            "actor_id": "actor-1",
            "hlc": Hlc(physical=1, logical=2),
            "affected_node_ids": ["node-1"],
            "op_type": "node.create",
        },
        payload={"nodeId": "node-1", "kind": "page", "index": "0"},
    )
    writer.write_operation(op)

    row = sqlite3.connect(str(path)).execute("SELECT * FROM operation").fetchone()
    assert row is not None
    assert row[0] == op.envelope.id
    writer.close()
