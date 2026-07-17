"""Unit tests for the inline link and reference migration path."""

from __future__ import annotations

from typing import Any
from uuid import uuid4

import pytest

from app.core.migration.links import (
    map_property_relation_targets,
    migrate_links_for_workspace,
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
    """In-memory asyncpg connection used for link migration tests."""

    def __init__(
        self,
        workspace_uuid: str,
        *,
        nodes: list[dict[str, Any]] | None = None,
        links: list[dict[str, Any]] | None = None,
        relations: list[dict[str, Any]] | None = None,
    ) -> None:
        self._workspace_uuid = workspace_uuid
        self._nodes = [_FakeRecord(n) for n in (nodes or [])]
        self._links = [_FakeRecord(link) for link in (links or [])]
        self._relations = [_FakeRecord(r) for r in (relations or [])]

    async def fetch(self, query: str, *args: Any) -> list[_FakeRecord]:
        if "node_link" in query:
            return self._links
        if "property_value_relation" in query:
            return self._relations
        if "FROM node" in query and "is_deleted = FALSE" in query:
            return self._nodes
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


def _link(
    link_id: int,
    *,
    source_id: int,
    target_id: int,
    position: int = 0,
    name: str | None = None,
    is_inline_class: bool = False,
    is_embed: bool = False,
) -> dict[str, Any]:
    return {
        "id": link_id,
        "uuid": uuid4(),
        "source_id": source_id,
        "target_id": target_id,
        "property_id": None,
        "position": position,
        "is_tag": False,
        "is_inline_class": is_inline_class,
        "is_embed": is_embed,
        "name": name,
    }


def _node(node_id: int, name: str) -> dict[str, Any]:
    return {"id": node_id, "name": name}


@pytest.mark.unit
async def test_plain_text_link_becomes_node_link_ast() -> None:
    workspace_uuid = str(uuid4())
    source_uuid = str(uuid4())
    target_uuid = str(uuid4())
    nodes = [_node(1, "Hello [[2]] world")]
    links = [_link(1, source_id=1, target_id=2)]
    conn = _FakeConnection(workspace_uuid, nodes=nodes, links=links)
    ctx = _make_context(workspace_uuid, {1: source_uuid, 2: target_uuid})
    writer = InMemoryOperationWriter()

    count = await migrate_links_for_workspace(conn, 1, ctx, writer)

    assert count == 1
    updates = _find_ops(writer.operations, "node.updateContent")
    assert len(updates) == 1
    assert updates[0].payload["nodeId"] == source_uuid
    children = updates[0].payload["crdtUpdate"][0]["children"]
    assert children[0] == {"type": "text", "text": "Hello "}
    assert children[1]["type"] == "node_link"
    assert children[1]["link_id"] == target_uuid
    assert children[1]["ref_type"] == "node"
    assert children[2] == {"type": "text", "text": " world"}


@pytest.mark.unit
async def test_ast_link_gets_mapped_uuid() -> None:
    workspace_uuid = str(uuid4())
    source_uuid = str(uuid4())
    target_uuid = str(uuid4())
    name_ast = '[{"type":"paragraph","children":[{"type":"node_link","link_id":"2","ref_type":"node"}]}]'
    nodes = [_node(1, name_ast)]
    links = [_link(1, source_id=1, target_id=2)]
    conn = _FakeConnection(workspace_uuid, nodes=nodes, links=links)
    ctx = _make_context(workspace_uuid, {1: source_uuid, 2: target_uuid})
    writer = InMemoryOperationWriter()

    await migrate_links_for_workspace(conn, 1, ctx, writer)

    updates = _find_ops(writer.operations, "node.updateContent")
    children = updates[0].payload["crdtUpdate"][0]["children"]
    assert children[0]["type"] == "node_link"
    assert children[0]["link_id"] == target_uuid


@pytest.mark.unit
async def test_link_with_label_preserves_label() -> None:
    workspace_uuid = str(uuid4())
    source_uuid = str(uuid4())
    target_uuid = str(uuid4())
    nodes = [_node(1, "See [[2]]")]
    links = [_link(1, source_id=1, target_id=2, name="Page")]
    conn = _FakeConnection(workspace_uuid, nodes=nodes, links=links)
    ctx = _make_context(workspace_uuid, {1: source_uuid, 2: target_uuid})
    writer = InMemoryOperationWriter()

    await migrate_links_for_workspace(conn, 1, ctx, writer)

    updates = _find_ops(writer.operations, "node.updateContent")
    link_node = updates[0].payload["crdtUpdate"][0]["children"][1]
    assert link_node["label"] == "Page"


@pytest.mark.unit
async def test_inline_class_ref_type() -> None:
    workspace_uuid = str(uuid4())
    source_uuid = str(uuid4())
    target_uuid = str(uuid4())
    name_ast = (
        '[{"type":"paragraph","children":['
        '{"type":"node_link","link_id":"2","ref_type":"class"}]'
        '}]'
    )
    nodes = [_node(1, name_ast)]
    links = [_link(1, source_id=1, target_id=2, is_inline_class=True)]
    conn = _FakeConnection(workspace_uuid, nodes=nodes, links=links)
    ctx = _make_context(workspace_uuid, {1: source_uuid, 2: target_uuid})
    writer = InMemoryOperationWriter()

    await migrate_links_for_workspace(conn, 1, ctx, writer)

    updates = _find_ops(writer.operations, "node.updateContent")
    link_node = updates[0].payload["crdtUpdate"][0]["children"][0]
    assert link_node["ref_type"] == "class"


@pytest.mark.unit
async def test_embed_ref_type() -> None:
    workspace_uuid = str(uuid4())
    source_uuid = str(uuid4())
    target_uuid = str(uuid4())
    nodes = [_node(1, "Embed ((2))")]
    links = [_link(1, source_id=1, target_id=2, is_embed=True)]
    conn = _FakeConnection(workspace_uuid, nodes=nodes, links=links)
    ctx = _make_context(workspace_uuid, {1: source_uuid, 2: target_uuid})
    writer = InMemoryOperationWriter()

    await migrate_links_for_workspace(conn, 1, ctx, writer)

    updates = _find_ops(writer.operations, "node.updateContent")
    link_node = updates[0].payload["crdtUpdate"][0]["children"][1]
    assert link_node["ref_type"] == "embed"


@pytest.mark.unit
async def test_nodes_without_links_generate_no_ops() -> None:
    workspace_uuid = str(uuid4())
    nodes = [_node(1, "Just text")]
    conn = _FakeConnection(workspace_uuid, nodes=nodes, links=[])
    ctx = _make_context(workspace_uuid, {1: str(uuid4())})
    writer = InMemoryOperationWriter()

    count = await migrate_links_for_workspace(conn, 1, ctx, writer)

    assert count == 0


@pytest.mark.unit
async def test_no_integer_ids_in_operations() -> None:
    workspace_uuid = str(uuid4())
    nodes = [_node(1, "[[2]]")]
    links = [_link(1, source_id=1, target_id=2)]
    conn = _FakeConnection(workspace_uuid, nodes=nodes, links=links)
    ctx = _make_context(workspace_uuid, {1: str(uuid4()), 2: str(uuid4())})
    writer = InMemoryOperationWriter()

    await migrate_links_for_workspace(conn, 1, ctx, writer)

    for op in writer.operations:
        for value in op.payload.values():
            if isinstance(value, str):
                assert not value.isdigit(), f"integer id leaked: {value}"
        for value in op.envelope.affected_node_ids:
            assert not value.isdigit(), f"integer id leaked in affected ids: {value}"


@pytest.mark.unit
async def test_hlcs_increase_across_link_ops() -> None:
    workspace_uuid = str(uuid4())
    nodes = [_node(1, "[[2]]"), _node(3, "[[4]]")]
    links = [
        _link(1, source_id=1, target_id=2),
        _link(2, source_id=3, target_id=4),
    ]
    conn = _FakeConnection(workspace_uuid, nodes=nodes, links=links)
    ctx = _make_context(workspace_uuid, {})
    writer = InMemoryOperationWriter()

    await migrate_links_for_workspace(conn, 1, ctx, writer)

    physical = writer.operations[0].envelope.hlc.physical
    for idx, op in enumerate(writer.operations):
        assert op.envelope.hlc.physical == physical
        assert op.envelope.hlc.logical == idx


@pytest.mark.unit
async def test_property_relation_targets_are_mapped() -> None:
    workspace_uuid = str(uuid4())
    relations = [
        {
            "id": 1,
            "node_id": 1,
            "property_id": 10,
            "target_id": 2,
            "type": "node",
        }
    ]
    conn = _FakeConnection(workspace_uuid, relations=relations)
    ctx = _make_context(workspace_uuid, {})

    mapping = await map_property_relation_targets(conn, 1, ctx)

    assert len(mapping) == 1
    key = (1, 10, 2)
    assert key in mapping
    mapped = mapping[key]
    assert mapped in ctx.id_map.values()
    assert len(mapped) == 36
