"""Unit tests for the asset migration path."""

from __future__ import annotations

from pathlib import Path
from typing import Any
from uuid import uuid4

import pytest

from app.core.migration.assets import (
    migrate_assets_for_workspace,
)
from app.core.migration.nodes import MigrationContext
from app.core.migration.writer import InMemoryOperationWriter
from app.core.operation import Operation


class _FakeRecord:
    """Minimal asyncpg.Record stand-in."""

    def __init__(self, data: dict[str, Any]) -> None:
        self._data = data

    def __getitem__(self, key: str) -> Any:
        return self._data[key]

    def get(self, key: str, default: Any = None) -> Any:
        return self._data.get(key, default)


class _FakeConnection:
    """In-memory asyncpg connection used for asset migration tests."""

    def __init__(
        self,
        workspace_uuid: str,
        *,
        assets: list[dict[str, Any]] | None = None,
        asset_nodes: list[dict[str, Any]] | None = None,
    ) -> None:
        self._workspace_uuid = workspace_uuid
        self._assets = [_FakeRecord(a) for a in (assets or [])]
        self._asset_nodes = [_FakeRecord(n) for n in (asset_nodes or [])]

    async def fetch(self, query: str, *args: Any) -> list[_FakeRecord]:
        if "FROM asset" in query:
            return self._assets
        if "FROM node" in query and "asset_id" in query:
            asset_id = args[0] if args else None
            return [
                n for n in self._asset_nodes if n["asset_id"] == asset_id
            ]
        if "FROM node" in query and "id = ANY" in query:
            ids = args[0] if args else []
            return [n for n in self._asset_nodes if n["id"] in ids]
        return []

    async def fetchrow(self, query: str, *args: Any) -> _FakeRecord | None:
        if "workspace" in query.lower():
            return _FakeRecord({"uuid": self._workspace_uuid})
        return None

    async def close(self) -> None:
        pass


def _make_context(workspace_uuid: str, id_map: dict[int, str]) -> MigrationContext:
    return MigrationContext(
        workspace_uuid=workspace_uuid,
        actor_id="actor-1",
        system_class_ids={},
        id_map=id_map,
        physical_time=1000,
    )


def _find_ops(ops: list[Operation], op_type: str) -> list[Operation]:
    return [op for op in ops if op.envelope.op_type == op_type]


def _asset(
    asset_id: int,
    *,
    uuid: str | None = None,
    file_hash: str = "a" * 64,
    size: int = 1234,
    mime_type: str = "image/png",
    original_name: str = "image.png",
) -> dict[str, Any]:
    return {
        "id": asset_id,
        "uuid": uuid or uuid4(),
        "workspace_id": 1,
        "hash": file_hash,
        "size": size,
        "mime_type": mime_type,
        "original_name": original_name,
    }


@pytest.mark.unit
async def test_generates_create_assign_and_property_ops() -> None:
    workspace_uuid = str(uuid4())
    asset_uuid = str(uuid4())
    assets = [_asset(1, uuid=asset_uuid, file_hash="ab" * 32)]
    conn = _FakeConnection(workspace_uuid, assets=assets)
    ctx = _make_context(workspace_uuid, {})
    writer = InMemoryOperationWriter()

    count = await migrate_assets_for_workspace(
        conn, 1, ctx, writer, copy_files=False
    )

    assert count == 3
    creates = _find_ops(writer.operations, "node.create")
    assigns = _find_ops(writer.operations, "class.assign")
    sets = _find_ops(writer.operations, "property.set")
    assert len(creates) == len(assigns) == len(sets) == 1
    assert creates[0].payload["nodeId"] == asset_uuid
    assert creates[0].payload["kind"] == "block"
    assert assigns[0].payload["nodeId"] == asset_uuid
    assert sets[0].payload["nodeId"] == asset_uuid
    assert sets[0].payload["propertyValueId"]
    assert sets[0].payload["index"] == 0
    assert sets[0].payload["value"]["value"]["hash"] == "ab" * 32
    assert sets[0].payload["value"]["value"]["filename"] == "image.png"
    assert sets[0].payload["value"]["value"]["mime_type"] == "image/png"
    assert sets[0].payload["value"]["value"]["size"] == 1234


@pytest.mark.unit
async def test_preserves_referencing_node_uuid() -> None:
    workspace_uuid = str(uuid4())
    node_uuid = str(uuid4())
    assets = [_asset(1, file_hash="ab" * 32)]
    asset_nodes = [
        {"id": 10, "uuid": node_uuid, "asset_id": 1, "is_page": False, "is_asset": True}
    ]
    conn = _FakeConnection(
        workspace_uuid, assets=assets, asset_nodes=asset_nodes
    )
    ctx = _make_context(workspace_uuid, {10: node_uuid})
    writer = InMemoryOperationWriter()

    await migrate_assets_for_workspace(conn, 1, ctx, writer, copy_files=False)

    creates = _find_ops(writer.operations, "node.create")
    assert creates[0].payload["nodeId"] == node_uuid


@pytest.mark.unit
async def test_page_kind_when_referencing_node_is_page() -> None:
    workspace_uuid = str(uuid4())
    assets = [_asset(1)]
    asset_nodes = [
        {"id": 10, "uuid": uuid4(), "asset_id": 1, "is_page": True, "is_asset": False}
    ]
    conn = _FakeConnection(
        workspace_uuid, assets=assets, asset_nodes=asset_nodes
    )
    ctx = _make_context(workspace_uuid, {})
    writer = InMemoryOperationWriter()

    await migrate_assets_for_workspace(conn, 1, ctx, writer, copy_files=False)

    creates = _find_ops(writer.operations, "node.create")
    assert creates[0].payload["kind"] == "page"


@pytest.mark.unit
async def test_file_class_is_system_and_stable() -> None:
    workspace_uuid = str(uuid4())
    assets = [_asset(1), _asset(2)]
    conn = _FakeConnection(workspace_uuid, assets=assets)
    ctx = _make_context(workspace_uuid, {})
    writer = InMemoryOperationWriter()

    await migrate_assets_for_workspace(conn, 1, ctx, writer, copy_files=False)

    assigns = _find_ops(writer.operations, "class.assign")
    class_ids = {op.payload["classId"] for op in assigns}
    assert len(class_ids) == 1


@pytest.mark.unit
async def test_no_integer_ids_in_operations() -> None:
    workspace_uuid = str(uuid4())
    assets = [_asset(1)]
    conn = _FakeConnection(workspace_uuid, assets=assets)
    ctx = _make_context(workspace_uuid, {})
    writer = InMemoryOperationWriter()

    await migrate_assets_for_workspace(conn, 1, ctx, writer, copy_files=False)

    for op in writer.operations:
        for key, value in op.payload.items():
            if key == "index" or not isinstance(value, str):
                continue
            assert not value.isdigit(), f"integer id leaked in {key}: {value}"
        for value in op.envelope.affected_node_ids:
            assert not value.isdigit(), f"integer id leaked in affected ids: {value}"


@pytest.mark.unit
async def test_copies_file_from_hash_based_path(tmp_path: Path) -> None:
    workspace_uuid = str(uuid4())
    file_hash = "ab" * 32
    assets = [_asset(1, file_hash=file_hash, mime_type="image/png")]
    conn = _FakeConnection(workspace_uuid, assets=assets)
    ctx = _make_context(workspace_uuid, {})
    writer = InMemoryOperationWriter()

    assets_dir = tmp_path / "workspaces" / workspace_uuid / "assets" / file_hash[:4]
    assets_dir.mkdir(parents=True)
    source = assets_dir / f"{file_hash}.png"
    source.write_bytes(b"png-bytes")

    await migrate_assets_for_workspace(
        conn, 1, ctx, writer, data_dir=tmp_path, copy_files=True
    )

    destination = tmp_path / "workspaces" / workspace_uuid / "files" / f"{file_hash}.png"
    assert destination.exists()
    assert destination.read_bytes() == b"png-bytes"
    assert source.exists(), "original file must be preserved"


@pytest.mark.unit
async def test_copies_file_from_legacy_uuid_folder(tmp_path: Path) -> None:
    workspace_uuid = str(uuid4())
    asset_uuid = str(uuid4())
    file_hash = "cd" * 32
    assets = [
        _asset(
            1, uuid=asset_uuid, file_hash=file_hash, mime_type="image/jpeg"
        )
    ]
    conn = _FakeConnection(workspace_uuid, assets=assets)
    ctx = _make_context(workspace_uuid, {})
    writer = InMemoryOperationWriter()

    asset_folder = tmp_path / "workspaces" / workspace_uuid / "assets" / asset_uuid
    asset_folder.mkdir(parents=True)
    source = asset_folder / "main.jpeg"
    source.write_bytes(b"jpeg-bytes")

    await migrate_assets_for_workspace(
        conn, 1, ctx, writer, data_dir=tmp_path, copy_files=True
    )

    destination = tmp_path / "workspaces" / workspace_uuid / "files" / f"{file_hash}.jpg"
    assert destination.exists()
    assert destination.read_bytes() == b"jpeg-bytes"


@pytest.mark.unit
async def test_missing_source_file_does_not_crash() -> None:
    workspace_uuid = str(uuid4())
    assets = [_asset(1)]
    conn = _FakeConnection(workspace_uuid, assets=assets)
    ctx = _make_context(workspace_uuid, {})
    writer = InMemoryOperationWriter()

    count = await migrate_assets_for_workspace(
        conn, 1, ctx, writer, data_dir=Path("/nonexistent"), copy_files=True
    )

    assert count == 3
