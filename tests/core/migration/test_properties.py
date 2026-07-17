"""Unit tests for the property/class/schema migration path."""

from __future__ import annotations

from typing import Any
from uuid import uuid4

import pytest

from app.core.migration.nodes import MigrationContext
from app.core.migration.properties import migrate_properties_for_workspace
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
    """In-memory asyncpg connection used for property migration tests."""

    def __init__(
        self,
        workspace_uuid: str,
        *,
        properties: list[dict[str, Any]] | None = None,
        selection_lines: list[dict[str, Any]] | None = None,
        node_properties: list[dict[str, Any]] | None = None,
        scalar_values: list[dict[str, Any]] | None = None,
        relation_values: list[dict[str, Any]] | None = None,
        selection_values: list[dict[str, Any]] | None = None,
        class_properties: list[dict[str, Any]] | None = None,
        class_extends: list[dict[str, Any]] | None = None,
        class_node_names: dict[int, str] | None = None,
    ) -> None:
        self._workspace_uuid = workspace_uuid
        self._properties = [_FakeRecord(p) for p in (properties or [])]
        self._selection_lines = [_FakeRecord(p) for p in (selection_lines or [])]
        self._node_properties = [_FakeRecord(p) for p in (node_properties or [])]
        self._scalar_values = [_FakeRecord(p) for p in (scalar_values or [])]
        self._relation_values = [_FakeRecord(p) for p in (relation_values or [])]
        self._selection_values = [_FakeRecord(p) for p in (selection_values or [])]
        self._class_properties = [_FakeRecord(p) for p in (class_properties or [])]
        self._class_extends = [_FakeRecord(p) for p in (class_extends or [])]
        self._class_node_names = class_node_names or {}

    async def fetch(self, query: str, *args: Any) -> list[_FakeRecord]:
        if "property_selection_line" in query:
            return self._selection_lines
        if "FROM property\n" in query:
            return self._properties
        if "node_property np" in query:
            return self._node_properties
        if "property_value_scalar" in query:
            return self._scalar_values
        if "property_value_relation" in query:
            return self._relation_values
        if "property_value_selection" in query:
            return self._selection_values
        if "class_property cp" in query:
            return self._class_properties
        if "class_extend ce" in query:
            return self._class_extends
        if "FROM node\n" in query and "id = ANY" in query:
            ids = args[0] if args else []
            return [
                _FakeRecord({"id": i, "name": self._class_node_names.get(i, "")})
                for i in ids
            ]
        return []

    async def fetchrow(self, query: str, *args: Any) -> _FakeRecord | None:
        if "workspace" in query.lower():
            return _FakeRecord({"uuid": self._workspace_uuid})
        return None

    async def close(self) -> None:
        pass


def _make_context(workspace_uuid: str, id_map: dict[int, str]) -> MigrationContext:
    """Build a migration context with a populated node id map."""
    return MigrationContext(
        workspace_uuid=workspace_uuid,
        actor_id="actor-1",
        system_class_ids={},
        id_map=id_map,
        physical_time=1000,
    )


def _find_ops(ops: list[Operation], op_type: str) -> list[Operation]:
    return [op for op in ops if op.envelope.op_type == op_type]


def _property(
    property_id: int,
    name: str,
    prop_type: str,
    *,
    uuid: str | None = None,
    is_multi: bool = False,
) -> dict[str, Any]:
    return {
        "id": property_id,
        "uuid": uuid or uuid4(),
        "name": name,
        "icon": None,
        "type": prop_type,
        "is_multi": is_multi,
        "is_system": False,
        "scope": "global",
        "node_id": None,
        "icon_visibility": "hidden",
    }


def _selection_line(
    line_id: int,
    *,
    property_id: int,
    uuid: str | None = None,
    name: str = "Option",
    icon: str | None = None,
    sequence: int = 0,
) -> dict[str, Any]:
    return {
        "id": line_id,
        "uuid": uuid or uuid4(),
        "property_id": property_id,
        "name": name,
        "icon": icon,
        "sequence": sequence,
    }


def _node_property(
    np_id: int,
    *,
    node_id: int,
    property_id: int,
    uuid: str | None = None,
) -> dict[str, Any]:
    return {
        "id": np_id,
        "uuid": uuid or uuid4(),
        "node_id": node_id,
        "property_id": property_id,
    }


def _scalar_value(
    value_id: int,
    *,
    node_property_id: int,
    property_id: int,
    node_id: int,
    uuid: str | None = None,
    value_text: str | None = None,
    value_integer: int | None = None,
    value_float: float | None = None,
    value_boolean: bool | None = None,
) -> dict[str, Any]:
    return {
        "id": value_id,
        "uuid": uuid or uuid4(),
        "node_property_id": node_property_id,
        "property_id": property_id,
        "node_id": node_id,
        "value_text": value_text,
        "value_integer": value_integer,
        "value_float": value_float,
        "value_boolean": value_boolean,
    }


def _relation_value(
    value_id: int,
    *,
    node_property_id: int,
    property_id: int,
    node_id: int,
    target_id: int,
    uuid: str | None = None,
    order: int = 0,
) -> dict[str, Any]:
    return {
        "id": value_id,
        "uuid": uuid or uuid4(),
        "node_property_id": node_property_id,
        "property_id": property_id,
        "node_id": node_id,
        "target_id": target_id,
        "order": order,
    }


def _selection_value(
    value_id: int,
    *,
    node_property_id: int,
    property_id: int,
    node_id: int,
    selection_line_id: int,
    uuid: str | None = None,
) -> dict[str, Any]:
    return {
        "id": value_id,
        "uuid": uuid or uuid4(),
        "node_property_id": node_property_id,
        "property_id": property_id,
        "node_id": node_id,
        "selection_line_id": selection_line_id,
    }


def _class_property(
    cp_id: int,
    *,
    class_node_id: int,
    property_id: int,
    uuid: str | None = None,
    sequence: int = 0,
) -> dict[str, Any]:
    return {
        "id": cp_id,
        "uuid": uuid or uuid4(),
        "class_node_id": class_node_id,
        "property_id": property_id,
        "sequence": sequence,
        "hidden": False,
        "required": None,
        "readonly": None,
        "hide_when_empty": None,
    }


def _class_extend(
    ce_id: int,
    *,
    target_id: int,
    source_id: int,
    uuid: str | None = None,
    sequence: int = 0,
) -> dict[str, Any]:
    return {
        "id": ce_id,
        "uuid": uuid or uuid4(),
        "target_id": target_id,
        "source_id": source_id,
        "sequence": sequence,
    }


@pytest.mark.unit
async def test_property_schema_type_mapping() -> None:
    """Legacy property types map to the expected ideal schema types/config."""
    workspace_uuid = str(uuid4())
    properties = [
        _property(1, "Text prop", "text"),
        _property(2, "Integer prop", "integer"),
        _property(3, "Float prop", "float"),
        _property(4, "Date prop", "date"),
        _property(5, "Date range prop", "date_range"),
        _property(6, "Selection prop", "selection", is_multi=True),
        _property(7, "Node prop", "node"),
        _property(8, "Boolean prop", "boolean"),
        _property(9, "URL prop", "url"),
        _property(10, "Email prop", "email"),
        _property(11, "Image prop", "image"),
    ]
    conn = _FakeConnection(workspace_uuid, properties=properties)
    ctx = _make_context(workspace_uuid, {})

    ops = await migrate_properties_for_workspace(conn, 1, ctx)

    creates = _find_ops(ops, "propertySchema.create")
    assert len(creates) == len(properties)
    mapped = {
        op.payload["name"]: (op.payload["type"], op.payload["config"])
        for op in creates
    }
    assert mapped["Text prop"] == ("text", {})
    assert mapped["Integer prop"] == ("number", {})
    assert mapped["Float prop"] == ("number", {})
    assert mapped["Date prop"] == ("date", {})
    assert mapped["Date range prop"] == ("date", {})
    assert mapped["Selection prop"] == ("multi_select", {})
    assert mapped["Node prop"] == ("node", {})
    assert mapped["Boolean prop"] == ("checkbox", {})
    assert mapped["URL prop"] == ("text", {"format": "url"})
    assert mapped["Email prop"] == ("text", {"format": "email"})
    assert mapped["Image prop"] == ("file", {})


@pytest.mark.unit
async def test_property_schema_options_and_uuid_preservation() -> None:
    """Selection options are embedded in config and existing UUIDs are kept."""
    workspace_uuid = str(uuid4())
    prop_uuid = str(uuid4())
    line_uuid = str(uuid4())
    properties = [_property(1, "Status", "selection", uuid=prop_uuid)]
    selection_lines = [
        _selection_line(1, property_id=1, uuid=line_uuid, name="Active")
    ]
    conn = _FakeConnection(
        workspace_uuid, properties=properties, selection_lines=selection_lines
    )
    ctx = _make_context(workspace_uuid, {})

    ops = await migrate_properties_for_workspace(conn, 1, ctx)

    creates = _find_ops(ops, "propertySchema.create")
    assert len(creates) == 1
    payload = creates[0].payload
    assert payload["schemaId"] == prop_uuid
    assert payload["type"] == "select"
    assert payload["config"]["options"] == [
        {"id": line_uuid, "name": "Active", "sequence": 0}
    ]


@pytest.mark.unit
async def test_property_value_generation() -> None:
    """Scalar, relation, and selection values become property.set operations."""
    workspace_uuid = str(uuid4())
    node_uuid = str(uuid4())
    target_uuid = str(uuid4())
    line_uuid = str(uuid4())
    value_uuids = {name: str(uuid4()) for name in ["text", "int", "rel", "sel"]}

    properties = [
        _property(1, "Notes", "text"),
        _property(2, "Count", "integer"),
        _property(3, "Related", "node"),
        _property(4, "Status", "selection"),
    ]
    selection_lines = [_selection_line(1, property_id=4, uuid=line_uuid, name="Done")]
    node_properties = [
        _node_property(1, node_id=10, property_id=1),
        _node_property(2, node_id=10, property_id=2),
        _node_property(3, node_id=10, property_id=3),
        _node_property(4, node_id=10, property_id=4),
    ]
    scalar_values = [
        _scalar_value(
            1, uuid=value_uuids["text"], node_property_id=1, property_id=1,
            node_id=10, value_text="hello"
        ),
        _scalar_value(
            2, uuid=value_uuids["int"], node_property_id=2, property_id=2,
            node_id=10, value_integer=42
        ),
    ]
    relation_values = [
        _relation_value(
            3, uuid=value_uuids["rel"], node_property_id=3, property_id=3,
            node_id=10, target_id=20, order=1
        )
    ]
    selection_values = [
        _selection_value(
            4, uuid=value_uuids["sel"], node_property_id=4, property_id=4,
            node_id=10, selection_line_id=1
        )
    ]

    conn = _FakeConnection(
        workspace_uuid,
        properties=properties,
        selection_lines=selection_lines,
        node_properties=node_properties,
        scalar_values=scalar_values,
        relation_values=relation_values,
        selection_values=selection_values,
    )
    ctx = _make_context(workspace_uuid, {10: node_uuid, 20: target_uuid})

    ops = await migrate_properties_for_workspace(conn, 1, ctx)
    sets = _find_ops(ops, "property.set")
    assert len(sets) == 4

    by_schema = {op.payload["schemaId"]: op.payload for op in sets}
    assert by_schema[list(by_schema.keys())[0]]["nodeId"] == node_uuid

    text_op = next(
        op for op in sets if op.payload["value"] == {"value": "hello"}
    )
    assert text_op.payload["index"] == 0
    assert text_op.payload["propertyValueId"] == value_uuids["text"]

    int_op = next(
        op for op in sets if op.payload["value"] == {"value": 42}
    )
    assert int_op.payload["propertyValueId"] == value_uuids["int"]

    rel_op = next(
        op for op in sets if op.payload["value"] == {"value": target_uuid}
    )
    assert rel_op.payload["index"] == 1
    assert rel_op.payload["propertyValueId"] == value_uuids["rel"]

    sel_op = next(
        op for op in sets if op.payload["value"] == {"value": line_uuid}
    )
    assert sel_op.payload["index"] == 0
    assert sel_op.payload["propertyValueId"] == value_uuids["sel"]


@pytest.mark.unit
async def test_date_range_value_is_parsed() -> None:
    """date_range scalar values stored as JSON strings are parsed into objects."""
    workspace_uuid = str(uuid4())
    node_uuid = str(uuid4())
    prop_uuid = str(uuid4())
    properties = [_property(1, "Range", "date_range", uuid=prop_uuid)]
    node_properties = [_node_property(1, node_id=10, property_id=1)]
    scalar_values = [
        _scalar_value(
            1,
            node_property_id=1,
            property_id=1,
            node_id=10,
            value_text='{"start":"2025-01-01","end":"2025-01-31","granularity":"day"}',
        )
    ]

    conn = _FakeConnection(
        workspace_uuid,
        properties=properties,
        node_properties=node_properties,
        scalar_values=scalar_values,
    )
    ctx = _make_context(workspace_uuid, {10: node_uuid})

    ops = await migrate_properties_for_workspace(conn, 1, ctx)
    sets = _find_ops(ops, "property.set")
    assert len(sets) == 1
    assert sets[0].payload["value"]["value"] == {
        "start": "2025-01-01",
        "end": "2025-01-31",
        "granularity": "day",
    }


@pytest.mark.unit
async def test_values_without_node_property_assignment_are_skipped() -> None:
    """Orphaned values lacking a node_property row are not migrated."""
    workspace_uuid = str(uuid4())
    properties = [_property(1, "Notes", "text")]
    scalar_values = [
        _scalar_value(
            1,
            node_property_id=1,
            property_id=1,
            node_id=10,
            value_text="orphan",
        )
    ]

    conn = _FakeConnection(
        workspace_uuid,
        properties=properties,
        scalar_values=scalar_values,
    )
    ctx = _make_context(workspace_uuid, {10: str(uuid4())})

    ops = await migrate_properties_for_workspace(conn, 1, ctx)
    assert not _find_ops(ops, "property.set")


@pytest.mark.unit
async def test_class_property_schema_assignment() -> None:
    """class.create carries the property schemas assigned via class_property."""
    workspace_uuid = str(uuid4())
    class_uuid = str(uuid4())
    prop_uuid = str(uuid4())

    properties = [_property(1, "Due date", "date", uuid=prop_uuid)]
    class_properties = [
        _class_property(1, class_node_id=100, property_id=1, sequence=1)
    ]

    conn = _FakeConnection(
        workspace_uuid,
        properties=properties,
        class_properties=class_properties,
        class_node_names={100: "Task"},
    )
    ctx = _make_context(workspace_uuid, {100: class_uuid})

    ops = await migrate_properties_for_workspace(conn, 1, ctx)
    creates = _find_ops(ops, "class.create")
    assert len(creates) == 1
    payload = creates[0].payload
    assert payload["classId"] == class_uuid
    assert payload["name"] == "Task"
    assert payload["propertySchemaIds"] == [prop_uuid]
    assert payload["extends"] == []


@pytest.mark.unit
async def test_class_inheritance_via_extends() -> None:
    """class.create carries parent classes from class_extend."""
    workspace_uuid = str(uuid4())
    child_uuid = str(uuid4())
    parent_uuid = str(uuid4())

    class_extends = [
        _class_extend(1, target_id=200, source_id=201, sequence=0)
    ]

    conn = _FakeConnection(
        workspace_uuid,
        class_extends=class_extends,
        class_node_names={200: "Child", 201: "Parent"},
    )
    ctx = _make_context(workspace_uuid, {200: child_uuid, 201: parent_uuid})

    ops = await migrate_properties_for_workspace(conn, 1, ctx)
    creates = _find_ops(ops, "class.create")
    assert len(creates) == 1
    payload = creates[0].payload
    assert payload["classId"] == child_uuid
    assert payload["name"] == "Child"
    assert payload["propertySchemaIds"] == []
    assert payload["extends"] == [parent_uuid]


@pytest.mark.unit
async def test_hlcs_increase_across_properties_and_classes() -> None:
    """HLC logical counters increase monotonically across all generated ops."""
    workspace_uuid = str(uuid4())
    properties = [_property(i, f"P{i}", "text") for i in range(1, 4)]
    conn = _FakeConnection(workspace_uuid, properties=properties)
    ctx = _make_context(workspace_uuid, {})

    ops = await migrate_properties_for_workspace(conn, 1, ctx)
    assert len(ops) == 3
    physical = ops[0].envelope.hlc.physical
    for idx, op in enumerate(ops):
        assert op.envelope.hlc.physical == physical
        assert op.envelope.hlc.logical == idx


@pytest.mark.unit
async def test_no_integer_ids_in_operations() -> None:
    """No legacy integer ids leak into operation payloads or affected ids."""
    workspace_uuid = str(uuid4())
    node_uuid = str(uuid4())
    target_uuid = str(uuid4())
    properties = [
        _property(1, "Related", "node"),
        _property(2, "Status", "selection"),
    ]
    selection_lines = [_selection_line(1, property_id=2, name="Done")]
    node_properties = [
        _node_property(1, node_id=10, property_id=1),
        _node_property(2, node_id=10, property_id=2),
    ]
    relation_values = [
        _relation_value(1, node_property_id=1, property_id=1, node_id=10, target_id=20)
    ]
    selection_values = [
        _selection_value(2, node_property_id=2, property_id=2, node_id=10, selection_line_id=1)
    ]

    conn = _FakeConnection(
        workspace_uuid,
        properties=properties,
        selection_lines=selection_lines,
        node_properties=node_properties,
        relation_values=relation_values,
        selection_values=selection_values,
    )
    ctx = _make_context(workspace_uuid, {10: node_uuid, 20: target_uuid})

    ops = await migrate_properties_for_workspace(conn, 1, ctx)
    for op in ops:
        for value in op.payload.values():
            if isinstance(value, str):
                assert not value.isdigit(), f"integer id leaked: {value}"
            if isinstance(value, list):
                for item in value:
                    if isinstance(item, str):
                        assert not item.isdigit(), f"integer id leaked: {item}"
        for value in op.envelope.affected_node_ids:
            assert not value.isdigit(), f"integer id leaked in affected ids: {value}"
