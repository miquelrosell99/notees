"""Tests for the workspace seed and system-schema backfill (Task 3).

Covers the op sequence emitted by ``app/core/seed.py`` (classes with icons and
``extends``, class-scoped property schemas, classPropertyEdge bindings) and the
idempotent ``ensure_system_schema`` backfill that runs on workspace open for
pre-existing workspaces.
"""

from __future__ import annotations

import json

import pytest

from app.core.clock import Clock
from app.core.derived import replay_operations
from app.core.seed import (
    _class_operations,
    _edge_sequences,
    _page_operations,
    _system_schema_operations,
    ensure_system_schema,
)
from app.core.workspace_store import WorkspaceStore
from app.domain.entities.constants import (
    SYSTEM_CLASS_EXTENDS,
    SYSTEM_CLASS_UUIDS,
    SYSTEM_EXTRA_CLASS_BINDINGS,
    SYSTEM_PROPERTY_SCHEMA_SPECS,
    SYSTEM_PROPERTY_UUIDS,
)
from app.relay.storage import SqliteRelayStorage
from tests.core.fakes import FakeKeyStorage

pytestmark = pytest.mark.unit

SOURCE = SYSTEM_CLASS_UUIDS["source"]
AGENT = SYSTEM_CLASS_UUIDS["agent"]
ASSET = SYSTEM_CLASS_UUIDS["asset"]

CLASS_COUNT = len(SYSTEM_CLASS_UUIDS)
SCHEMA_COUNT = len(SYSTEM_PROPERTY_SCHEMA_SPECS)
EXTRA_BINDING_COUNT = len(SYSTEM_EXTRA_CLASS_BINDINGS)
# class.create + node.updateContent per class; propertySchema.create +
# classPropertyEdge.create per schema; classPropertyEdge.create per extra
# binding (e.g. cover → source); node.create per default page.
SEED_OP_COUNT = CLASS_COUNT * 2 + SCHEMA_COUNT * 2 + EXTRA_BINDING_COUNT + 2


def _seed_operations(workspace_id: str = "ws-1", actor_id: str = "actor-1"):
    """Build the full fresh-workspace seed op sequence (relay seed order)."""
    clock = Clock(device_id=actor_id)
    ops = _class_operations(clock, workspace_id, actor_id)
    ops.extend(_system_schema_operations(clock, workspace_id, actor_id))
    ops.extend(_page_operations(clock, workspace_id, actor_id, "Test User"))
    return ops


def _make_store(workspace_id: str = "ws-1", actor_id: str = "actor-1") -> WorkspaceStore:
    return WorkspaceStore(
        workspace_id=workspace_id,
        actor_id=actor_id,
        relay_storage=SqliteRelayStorage(":memory:"),
        db_path=":memory:",
        key_storage=FakeKeyStorage(),
    )


def test_seed_operation_sequence_counts_and_order() -> None:
    ops = _seed_operations()
    assert len(ops) == SEED_OP_COUNT

    op_types = [op.envelope.op_type for op in ops]
    # Classes first (create + content per class), then schemas, then pages.
    assert op_types[: CLASS_COUNT * 2] == ["class.create", "node.updateContent"] * CLASS_COUNT
    schema_section = op_types[CLASS_COUNT * 2 : CLASS_COUNT * 2 + SCHEMA_COUNT * 2]
    assert schema_section == ["propertySchema.create", "classPropertyEdge.create"] * SCHEMA_COUNT
    # Extra bindings (e.g. cover → source) are edge-only ops after the schemas.
    extra_section = op_types[CLASS_COUNT * 2 + SCHEMA_COUNT * 2 : -2]
    assert extra_section == ["classPropertyEdge.create"] * EXTRA_BINDING_COUNT
    assert op_types[-2:] == ["node.create", "node.create"]

    # Parents are created before their subclasses so closures derive fully.
    create_order = [op.payload["name"] for op in ops if op.envelope.op_type == "class.create"]
    for child, parents in SYSTEM_CLASS_EXTENDS.items():
        for parent in parents:
            assert create_order.index(parent) < create_order.index(child)


def test_seed_class_create_payloads_carry_icon_and_extends() -> None:
    ops = _seed_operations()
    creates = {op.payload["name"]: op.payload for op in ops if op.envelope.op_type == "class.create"}

    book = creates["book"]
    assert book["classId"] == SYSTEM_CLASS_UUIDS["book"]
    assert book["extends"] == [SOURCE]
    assert book["icon"] == "mdiBookOpenVariant"

    person = creates["person"]
    assert person["extends"] == [AGENT]

    # Flat classes carry no extends key.
    assert "extends" not in creates["collection"]
    assert "extends" not in creates["highlight"]
    assert "extends" not in creates["weblink"]


def test_seed_derives_class_hierarchy_closure() -> None:
    conn = replay_operations(_seed_operations())

    rows = conn.execute("SELECT id, extends_class_ids, icon FROM class").fetchall()
    assert len(rows) == CLASS_COUNT
    by_id = {row["id"]: row for row in rows}
    assert json.loads(by_id[SYSTEM_CLASS_UUIDS["book"]]["extends_class_ids"]) == [SOURCE]
    assert json.loads(by_id[SYSTEM_CLASS_UUIDS["person"]]["extends_class_ids"]) == [AGENT]
    assert json.loads(by_id[SYSTEM_CLASS_UUIDS["collection"]]["extends_class_ids"]) == []

    closure = {
        (row["class_id"], row["ancestor_id"])
        for row in conn.execute("SELECT class_id, ancestor_id FROM class_hierarchy").fetchall()
    }
    for child_name in ("book", "paper", "article", "thesis", "document"):
        child = SYSTEM_CLASS_UUIDS[child_name]
        assert (child, child) in closure  # self row
        assert (child, SOURCE) in closure
    for child_name in ("person", "organization"):
        child = SYSTEM_CLASS_UUIDS[child_name]
        assert (child, AGENT) in closure


def test_seed_derives_class_scoped_property_schemas_and_edges() -> None:
    conn = replay_operations(_seed_operations())

    schemas = {
        row["name"]: row
        for row in conn.execute(
            "SELECT name, type, multi, is_system, scope, class_filter_uuids, options, default_value "
            "FROM property_schema"
        ).fetchall()
    }
    assert set(schemas) == set(SYSTEM_PROPERTY_SCHEMA_SPECS)
    for name, row in schemas.items():
        assert row["is_system"] == 1, name
        assert row["scope"] == "class", name

    attachments = schemas["attachments"]
    assert attachments["type"] == "node"
    assert attachments["multi"] == 1
    assert json.loads(attachments["class_filter_uuids"]) == [ASSET]

    authors = schemas["authors"]
    assert authors["multi"] == 1
    assert json.loads(authors["class_filter_uuids"]) == [AGENT]

    role = schemas["role"]
    assert role["type"] == "selection"
    assert [opt["name"] for opt in json.loads(role["options"])] == [
        "representation",
        "cover",
        "supplement",
        "attachment",
        "generated",
        "thumbnail",
        "other",
    ]

    highlight_asset = schemas["highlight_asset"]
    assert highlight_asset["type"] == "node"
    assert highlight_asset["multi"] == 0
    assert json.loads(highlight_asset["class_filter_uuids"]) == [ASSET]

    citekey = schemas["citekey"]
    assert citekey["type"] == "text"
    assert json.loads(citekey["default_value"]) == ""

    assert schemas["publication_date"]["type"] == "date"
    assert schemas["url"]["type"] == "url"

    edges = {
        (row["class_id"], row["property_schema_id"]): row["sequence"]
        for row in conn.execute(
            "SELECT class_id, property_schema_id, sequence FROM class_property_edge"
        ).fetchall()
    }
    assert len(edges) == SCHEMA_COUNT + EXTRA_BINDING_COUNT
    expected_sequences = _edge_sequences()
    for schema_name, spec in SYSTEM_PROPERTY_SCHEMA_SPECS.items():
        key = (SYSTEM_CLASS_UUIDS[spec["bindTo"]], SYSTEM_PROPERTY_UUIDS[schema_name])
        assert key in edges, schema_name
        assert edges[key] == expected_sequences[schema_name]

    # Extra bindings: cover → source at the next free sequence slot.
    assert edges[(SOURCE, SYSTEM_PROPERTY_UUIDS["cover"])] == 7

    # Source-bound schemas are ordered as in the canonical spec.
    source_edges = [
        (SYSTEM_PROPERTY_UUIDS[name], edges[(SOURCE, SYSTEM_PROPERTY_UUIDS[name])])
        for name in ("attachments", "authors", "isbn", "doi", "publication_date", "publisher", "citekey")
    ]
    assert [seq for _, seq in source_edges] == [0, 1, 2, 3, 4, 5, 6]


async def test_ensure_system_schema_emits_full_schema_then_converges() -> None:
    store = _make_store()
    try:
        # Fresh (empty) workspace: everything except the default pages is emitted.
        emitted = await ensure_system_schema(store)
        assert emitted == CLASS_COUNT * 2 + SCHEMA_COUNT * 2 + EXTRA_BINDING_COUNT

        # Second run is a no-op.
        assert await ensure_system_schema(store) == 0

        rows = await store.query("SELECT COUNT(*) AS c FROM class")
        assert rows[0]["c"] == CLASS_COUNT
        rows = await store.query("SELECT COUNT(*) AS c FROM property_schema")
        assert rows[0]["c"] == SCHEMA_COUNT
        rows = await store.query("SELECT COUNT(*) AS c FROM class_property_edge")
        assert rows[0]["c"] == SCHEMA_COUNT + EXTRA_BINDING_COUNT
        rows = await store.query(
            "SELECT COUNT(*) AS c FROM class_hierarchy WHERE class_id = ? AND ancestor_id = ?",
            (SYSTEM_CLASS_UUIDS["book"], SOURCE),
        )
        assert rows[0]["c"] == 1
    finally:
        await store.close()


async def test_ensure_backfills_extends_for_existing_flat_classes() -> None:
    """Workspaces seeded before the source hierarchy have flat classes."""
    store = _make_store()
    try:
        # Simulate a legacy workspace: all system classes exist but flat.
        for class_name, class_uuid in SYSTEM_CLASS_UUIDS.items():
            await store.create_class(class_uuid, class_name)
        await store.sync()

        emitted = await ensure_system_schema(store)
        # One class.setExtends per class with canonical parents, plus all
        # schemas and edges (classes themselves are skipped).
        assert emitted == len(SYSTEM_CLASS_EXTENDS) + SCHEMA_COUNT * 2 + EXTRA_BINDING_COUNT

        rows = await store.query(
            "SELECT extends_class_ids FROM class WHERE id = ?",
            (SYSTEM_CLASS_UUIDS["book"],),
        )
        assert json.loads(rows[0]["extends_class_ids"]) == [SOURCE]
        rows = await store.query(
            "SELECT extends_class_ids FROM class WHERE id = ?",
            (SYSTEM_CLASS_UUIDS["organization"],),
        )
        assert json.loads(rows[0]["extends_class_ids"]) == [AGENT]

        # Converged: a second run emits nothing and duplicates nothing.
        assert await ensure_system_schema(store) == 0
        rows = await store.query("SELECT COUNT(*) AS c FROM class")
        assert rows[0]["c"] == CLASS_COUNT
        rows = await store.query("SELECT COUNT(*) AS c FROM class_property_edge")
        assert rows[0]["c"] == SCHEMA_COUNT + EXTRA_BINDING_COUNT
    finally:
        await store.close()


async def test_ensure_backfills_only_missing_schema_entities() -> None:
    """A workspace missing only some schemas/edges gets exactly those ops."""
    store = _make_store()
    try:
        await ensure_system_schema(store)

        # Remove one schema (and its edge) plus one unrelated edge to
        # simulate partial state.
        await store.execute(
            "DELETE FROM property_schema WHERE id = ?",
            (SYSTEM_PROPERTY_UUIDS["doi"],),
        )
        await store.execute(
            "DELETE FROM class_property_edge WHERE class_id = ? AND property_schema_id = ?",
            (SOURCE, SYSTEM_PROPERTY_UUIDS["doi"]),
        )
        await store.execute(
            "DELETE FROM class_property_edge WHERE class_id = ? AND property_schema_id = ?",
            (SYSTEM_CLASS_UUIDS["weblink"], SYSTEM_PROPERTY_UUIDS["url"]),
        )

        emitted = await ensure_system_schema(store)
        # propertySchema.create for doi + classPropertyEdge.create for doi and url.
        assert emitted == 3
        assert await ensure_system_schema(store) == 0

        rows = await store.query("SELECT COUNT(*) AS c FROM property_schema")
        assert rows[0]["c"] == SCHEMA_COUNT
        rows = await store.query("SELECT COUNT(*) AS c FROM class_property_edge")
        assert rows[0]["c"] == SCHEMA_COUNT + EXTRA_BINDING_COUNT
    finally:
        await store.close()
