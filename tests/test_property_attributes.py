"""Integration tests for property attributes (required/default/readonly/hide-when-empty)."""

import asyncpg
import pytest
from httpx import AsyncClient

from app.db import schema
from app.domain.stringify_ast import (
    ParseMode,
    StringifyMode,
    StringifyOptions,
    parse_ast,
    stringify_ast,
)


async def _rerun_startup_schema(database_url: str) -> None:
    """Re-run the schema exactly the way backend startup does.

    main.py calls init_database(conn) on every startup; the db_pool fixture
    does it once on a fresh schema. This repeats it on the live database to
    simulate a container restart.
    """
    conn = await asyncpg.connect(database_url)
    try:
        await schema.init_database(conn)
    finally:
        await conn.close()


async def _text_value_node_name(db_pool, node_uuid: str, prop_uuid: str) -> str | None:
    """Name (serialized AST) of the text node a TEXT property value points to."""
    return await db_pool.fetchval(
        """
        SELECT n.name
        FROM property_value_relation pvr
        JOIN node src ON src.id = pvr.node_id
        JOIN node n ON n.id = pvr.target_id
        JOIN property p ON p.id = pvr.property_id
        WHERE src.uuid = $1 AND p.uuid = $2
        """,
        node_uuid,
        prop_uuid,
    )


def _plain_text(serialized_name: str) -> str:
    """Render a stored node name (serialized AST) as plain text."""
    return stringify_ast(
        parse_ast(serialized_name, ParseMode.JSON),
        StringifyOptions(mode=StringifyMode.TEXT_ONLY),
    )


async def _class_property_required(db_pool, class_uuid: str, prop_uuid: str):
    row = await db_pool.fetchrow(
        """
        SELECT cp.required
        FROM class_property cp
        JOIN node c ON c.id = cp.class_node_id
        JOIN property p ON p.id = cp.property_id
        WHERE c.uuid = $1 AND p.uuid = $2
        """,
        class_uuid,
        prop_uuid,
    )
    assert row is not None
    return row["required"]


@pytest.mark.asyncio
async def test_attribute_columns_exist(db_pool):
    """Migration adds attribute columns with correct nullability."""
    rows = await db_pool.fetch(
        """
        SELECT table_name, column_name, is_nullable, column_default
        FROM information_schema.columns
        WHERE (table_name = 'property' AND column_name IN
               ('required', 'readonly', 'hide_when_empty', 'default_integer',
                'default_float', 'default_text', 'default_boolean',
                'default_node_id', 'default_selection_id'))
           OR (table_name = 'class_property' AND column_name IN
               ('required', 'readonly', 'hide_when_empty'))
        """
    )
    cols = {(r["table_name"], r["column_name"]): r for r in rows}
    for col in ("required", "readonly", "hide_when_empty"):
        assert ("property", col) in cols, f"property.{col} missing"
        assert cols[("property", col)]["is_nullable"] == "NO"
        assert cols[("property", col)]["column_default"] == "false"
    for col in ("required", "readonly", "hide_when_empty"):
        assert ("class_property", col) in cols, f"class_property.{col} missing"
        assert cols[("class_property", col)]["is_nullable"] == "YES"
    for col in ("default_integer", "default_float", "default_text",
                "default_boolean", "default_node_id", "default_selection_id"):
        assert ("property", col) in cols, f"property.{col} missing"


@pytest.mark.asyncio
async def test_class_property_required_false_migrated_to_null(db_pool):
    """Pre-existing required=false rows mean 'inherit' (NULL), not 'force off'."""
    # The seed creates class_property rows with required=false; after migration
    # none of them may hold an explicit false.
    count = await db_pool.fetchval(
        "SELECT count(*) FROM class_property WHERE required = false"
    )
    assert count == 0


@pytest.mark.asyncio
async def test_class_property_default_persists_on_add(auth_client: AsyncClient):
    """POST /classes/{uuid}/properties must persist default_value (was silently dropped)."""
    prop_resp = await auth_client.post("/api/properties/", json={
        "name": "DefaultedStatus", "type": "selection", "scope": "global",
        "selection_lines": ["Alpha", "Beta"],
    })
    assert prop_resp.status_code == 200, prop_resp.text
    prop = prop_resp.json()
    option_uuid = prop["options"][0]["selection_line_uuid"]

    # Create a fresh class node
    class_resp = await auth_client.post("/api/nodes/", json={
        "name": "Test Class", "is_class": True,
    })
    assert class_resp.status_code == 200, class_resp.text
    class_uuid = class_resp.json()["uuid"]

    add_resp = await auth_client.post(
        f"/api/properties/classes/{class_uuid}/properties",
        json={"property_uuid": prop["property_uuid"], "default_value": option_uuid},
    )
    assert add_resp.status_code == 200, add_resp.text
    assert add_resp.json()["default_value"] == option_uuid


@pytest.mark.asyncio
async def test_class_property_patch_tri_state_and_default(auth_client: AsyncClient):
    """PATCH persists tri-state overrides and default_value (was silently ignored)."""
    prop_resp = await auth_client.post("/api/properties/", json={
        "name": "TriStateProp", "type": "boolean", "scope": "global",
    })
    prop_uuid = prop_resp.json()["property_uuid"]
    class_resp = await auth_client.post("/api/nodes/", json={
        "name": "TriState Class", "is_class": True,
    })
    class_uuid = class_resp.json()["uuid"]
    await auth_client.post(
        f"/api/properties/classes/{class_uuid}/properties",
        json={"property_uuid": prop_uuid},
    )
    url = f"/api/properties/classes/{class_uuid}/properties/{prop_uuid}"

    # force on
    r = await auth_client.patch(url, json={"required": True, "readonly": True})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["required"] is True and body["readonly"] is True
    assert body["hide_when_empty"] is None  # untouched -> inherit

    # force off + default
    r = await auth_client.patch(url, json={"required": False, "default_value": True})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["required"] is False and body["default_value"] is True

    # back to inherit (explicit null) — requires model_fields_set handling
    r = await auth_client.patch(url, json={"required": None})
    assert r.status_code == 200, r.text
    assert r.json()["required"] is None


@pytest.mark.asyncio
async def test_inherited_properties_ordered_nearest_edge_first(auth_client: AsyncClient):
    """GET /classes/{uuid}/properties?include_inherited=true must return the
    direct class's edge before an ancestor's edge for the same property, even
    when the ancestor edge has a lower sequence. Display dedup is
    first-occurrence-wins, so this ordering is what makes the shown attributes
    agree with nearest-edge-first enforcement (get_class_property_edges_for_node).
    """
    prop_resp = await auth_client.post("/api/properties/", json={
        "name": "NearestEdgeProp", "type": "boolean", "scope": "global",
    })
    assert prop_resp.status_code == 200, prop_resp.text
    prop_uuid = prop_resp.json()["property_uuid"]

    parent_uuid = (await auth_client.post(
        "/api/nodes/", json={"name": "Parent Class", "is_class": True}
    )).json()["uuid"]
    child_uuid = (await auth_client.post(
        "/api/nodes/", json={"name": "Child Class", "is_class": True}
    )).json()["uuid"]

    # Ancestor edge with LOWER sequence + hide_when_empty=true: under the old
    # ORDER BY cp.sequence this edge sorted first and won the frontend dedup,
    # disagreeing with enforcement, which resolves nearest-class-first.
    r = await auth_client.post(
        f"/api/properties/classes/{parent_uuid}/properties",
        json={"property_uuid": prop_uuid, "hide_when_empty": True, "sequence": 0},
    )
    assert r.status_code == 200, r.text
    r = await auth_client.post(
        f"/api/properties/classes/{child_uuid}/extends",
        json={"extends_class_node_uuid": parent_uuid, "sequence": 0},
    )
    assert r.status_code == 200, r.text
    r = await auth_client.post(
        f"/api/properties/classes/{child_uuid}/properties",
        json={"property_uuid": prop_uuid, "hide_when_empty": False, "sequence": 1},
    )
    assert r.status_code == 200, r.text

    resp = await auth_client.get(
        f"/api/properties/classes/{child_uuid}/properties?include_inherited=true"
    )
    assert resp.status_code == 200, resp.text
    edges = [
        cp for cp in resp.json()["class_properties"]
        if cp["property_uuid"] == prop_uuid
    ]
    assert len(edges) == 2
    assert edges[0]["class_node_uuid"] == child_uuid
    assert edges[0]["hide_when_empty"] is False
    assert edges[1]["class_node_uuid"] == parent_uuid
    assert edges[1]["hide_when_empty"] is True


@pytest.mark.asyncio
async def test_property_attributes_roundtrip(auth_client: AsyncClient):
    """PUT /api/properties/{uuid} persists attribute bases and typed default."""
    prop_resp = await auth_client.post("/api/properties/", json={
        "name": "AttrProp", "type": "selection", "scope": "global",
        "selection_lines": ["One", "Two"],
    })
    prop = prop_resp.json()
    assert prop["required"] is False
    assert prop["readonly"] is False
    assert prop["hide_when_empty"] is False
    assert prop["default_value"] is None
    option_uuid = prop["options"][1]["selection_line_uuid"]

    put_resp = await auth_client.put(
        f"/api/properties/{prop['property_uuid']}",
        json={"required": True, "hide_when_empty": True, "default_value": option_uuid},
    )
    assert put_resp.status_code == 200, put_resp.text
    body = put_resp.json()
    assert body["required"] is True
    assert body["hide_when_empty"] is True
    assert body["readonly"] is False
    assert body["default_value"] == option_uuid

    # GET returns the same
    get_resp = await auth_client.get(f"/api/properties/uuid/{prop['property_uuid']}")
    assert get_resp.json()["default_value"] == option_uuid

    # explicit null clears the default
    clear_resp = await auth_client.put(
        f"/api/properties/{prop['property_uuid']}", json={"default_value": None},
    )
    assert clear_resp.json()["default_value"] is None


@pytest.mark.asyncio
async def test_update_property_bogus_default_uuid_returns_404(auth_client: AsyncClient):
    """PUT with an unknown selection-line UUID must 404, not 500."""
    prop_resp = await auth_client.post("/api/properties/", json={
        "name": "BadDefaultProp", "type": "selection", "scope": "global",
        "selection_lines": ["One", "Two"],
    })
    assert prop_resp.status_code == 200, prop_resp.text
    prop_uuid = prop_resp.json()["property_uuid"]

    r = await auth_client.put(
        f"/api/properties/{prop_uuid}",
        json={"default_value": "00000000-0000-0000-0000-000000000000"},
    )
    assert r.status_code == 404, r.text


@pytest.mark.asyncio
async def test_update_class_property_bogus_default_uuid_returns_404(auth_client: AsyncClient):
    """PATCH class property with an unknown selection-line UUID must 404, not 500."""
    prop_resp = await auth_client.post("/api/properties/", json={
        "name": "BadCpDefaultProp", "type": "selection", "scope": "global",
        "selection_lines": ["One", "Two"],
    })
    assert prop_resp.status_code == 200, prop_resp.text
    prop_uuid = prop_resp.json()["property_uuid"]
    class_resp = await auth_client.post("/api/nodes/", json={
        "name": "BadDefault Class", "is_class": True,
    })
    assert class_resp.status_code == 200, class_resp.text
    class_uuid = class_resp.json()["uuid"]
    add_resp = await auth_client.post(
        f"/api/properties/classes/{class_uuid}/properties",
        json={"property_uuid": prop_uuid},
    )
    assert add_resp.status_code == 200, add_resp.text

    r = await auth_client.patch(
        f"/api/properties/classes/{class_uuid}/properties/{prop_uuid}",
        json={"default_value": "00000000-0000-0000-0000-000000000000"},
    )
    assert r.status_code == 404, r.text


@pytest.mark.asyncio
async def test_required_clear_resets_to_default(auth_client: AsyncClient):
    """Clearing an effective-required property with a default resets to default."""
    prop_resp = await auth_client.post("/api/properties/", json={
        "name": "ReqSel", "type": "selection", "scope": "global",
        "selection_lines": ["Open", "Shut"],
    })
    prop = prop_resp.json()
    prop_uuid = prop["property_uuid"]
    open_uuid = prop["options"][0]["selection_line_uuid"]
    shut_uuid = prop["options"][1]["selection_line_uuid"]
    await auth_client.put(f"/api/properties/{prop_uuid}",
                          json={"required": True, "default_value": open_uuid})

    node_uuid = (await auth_client.post("/api/nodes/", json={"name": "N"})).json()["uuid"]
    await auth_client.post(f"/api/nodes/{node_uuid}/properties",
                           json={"property_uuid": prop_uuid, "value": shut_uuid})

    # clear -> resets to default (200, not an error)
    r = await auth_client.post(f"/api/nodes/{node_uuid}/properties",
                               json={"property_uuid": prop_uuid, "value": None})
    assert r.status_code == 200, r.text
    content = (await auth_client.get(f"/api/nodes/page/{node_uuid}/content")).json()
    assert content["properties_uuid"][prop_uuid] == open_uuid


@pytest.mark.asyncio
async def test_required_clear_without_default_rejected(auth_client: AsyncClient):
    prop_resp = await auth_client.post("/api/properties/", json={
        "name": "ReqNoDefault", "type": "selection", "scope": "global",
        "selection_lines": ["A", "B"],
    })
    prop_uuid = prop_resp.json()["property_uuid"]
    a_uuid = prop_resp.json()["options"][0]["selection_line_uuid"]
    await auth_client.put(f"/api/properties/{prop_uuid}", json={"required": True})

    node_uuid = (await auth_client.post("/api/nodes/", json={"name": "N2"})).json()["uuid"]
    await auth_client.post(f"/api/nodes/{node_uuid}/properties",
                           json={"property_uuid": prop_uuid, "value": a_uuid})
    r = await auth_client.post(f"/api/nodes/{node_uuid}/properties",
                               json={"property_uuid": prop_uuid, "value": None})
    assert r.status_code == 400
    assert r.json()["detail"]["code"] == "required_property"
    # value untouched
    content = (await auth_client.get(f"/api/nodes/page/{node_uuid}/content")).json()
    assert content["properties_uuid"][prop_uuid] == a_uuid


@pytest.mark.asyncio
async def test_readonly_rejects_writes(auth_client: AsyncClient):
    prop_resp = await auth_client.post("/api/properties/", json={
        "name": "Locked", "type": "boolean", "scope": "global",
    })
    prop_uuid = prop_resp.json()["property_uuid"]
    await auth_client.put(f"/api/properties/{prop_uuid}", json={"readonly": True})
    node_uuid = (await auth_client.post("/api/nodes/", json={"name": "N3"})).json()["uuid"]
    r = await auth_client.post(f"/api/nodes/{node_uuid}/properties",
                               json={"property_uuid": prop_uuid, "value": True})
    assert r.status_code == 400
    assert r.json()["detail"]["code"] == "readonly_property"


@pytest.mark.asyncio
async def test_typed_scalar_endpoint_enforces_readonly(auth_client: AsyncClient):
    """POST .../scalar on a read-only property must be rejected."""
    prop_resp = await auth_client.post("/api/properties/", json={
        "name": "TypedLocked", "type": "integer", "scope": "global",
    })
    assert prop_resp.status_code == 200, prop_resp.text
    prop_uuid = prop_resp.json()["property_uuid"]
    await auth_client.put(f"/api/properties/{prop_uuid}", json={"readonly": True})
    node_uuid = (await auth_client.post("/api/nodes/", json={"name": "N4"})).json()["uuid"]
    r = await auth_client.post(
        f"/api/nodes/{node_uuid}/properties/{prop_uuid}/scalar",
        json={"value": 42},
    )
    assert r.status_code == 400
    assert r.json()["detail"]["code"] == "readonly_property"


@pytest.mark.asyncio
async def test_typed_scalar_endpoint_happy_path(auth_client: AsyncClient):
    """Typed write to a normal (non-readonly) property still succeeds."""
    prop_resp = await auth_client.post("/api/properties/", json={
        "name": "TypedOk", "type": "integer", "scope": "global",
    })
    assert prop_resp.status_code == 200, prop_resp.text
    prop_uuid = prop_resp.json()["property_uuid"]
    node_uuid = (await auth_client.post("/api/nodes/", json={"name": "N5"})).json()["uuid"]
    r = await auth_client.post(
        f"/api/nodes/{node_uuid}/properties/{prop_uuid}/scalar",
        json={"value": 42},
    )
    assert r.status_code == 200, r.text
    content = (await auth_client.get(f"/api/nodes/page/{node_uuid}/content")).json()
    assert content["properties_uuid"][prop_uuid] == 42


@pytest.mark.asyncio
async def test_batch_clear_required_without_default_rejected(auth_client: AsyncClient):
    """Batch-clearing an effective-required property without default → 400."""
    prop_resp = await auth_client.post("/api/properties/", json={
        "name": "BatchReq", "type": "selection", "scope": "global",
        "selection_lines": ["A", "B"],
    })
    prop = prop_resp.json()
    prop_uuid = prop["property_uuid"]
    a_uuid = prop["options"][0]["selection_line_uuid"]
    await auth_client.put(f"/api/properties/{prop_uuid}", json={"required": True})
    node_uuid = (await auth_client.post("/api/nodes/", json={"name": "N6"})).json()["uuid"]

    r = await auth_client.post("/api/nodes/batch/set", json={"items": [
        {"node_uuid": node_uuid, "property_uuid": prop_uuid, "value": a_uuid},
    ]})
    assert r.status_code == 200, r.text
    assert r.json()["succeeded"] == 1

    r = await auth_client.post("/api/nodes/batch/set", json={"items": [
        {"node_uuid": node_uuid, "property_uuid": prop_uuid, "value": None},
    ]})
    assert r.status_code == 400
    assert r.json()["detail"]["code"] == "required_property"
    # value untouched
    content = (await auth_client.get(f"/api/nodes/page/{node_uuid}/content")).json()
    assert content["properties_uuid"][prop_uuid] == a_uuid


@pytest.mark.asyncio
async def test_delete_required_property_resets_to_default(auth_client: AsyncClient):
    """DELETE on an effective-required property with a default resets to the default."""
    prop_resp = await auth_client.post("/api/properties/", json={
        "name": "DelReq", "type": "selection", "scope": "global",
        "selection_lines": ["Open", "Shut"],
    })
    prop = prop_resp.json()
    prop_uuid = prop["property_uuid"]
    open_uuid = prop["options"][0]["selection_line_uuid"]
    shut_uuid = prop["options"][1]["selection_line_uuid"]
    await auth_client.put(f"/api/properties/{prop_uuid}",
                          json={"required": True, "default_value": open_uuid})
    node_uuid = (await auth_client.post("/api/nodes/", json={"name": "N7"})).json()["uuid"]
    r = await auth_client.post(f"/api/nodes/{node_uuid}/properties",
                               json={"property_uuid": prop_uuid, "value": shut_uuid})
    assert r.status_code == 200, r.text

    r = await auth_client.delete(f"/api/nodes/{node_uuid}/properties/{prop_uuid}")
    assert r.status_code == 200, r.text
    content = (await auth_client.get(f"/api/nodes/page/{node_uuid}/content")).json()
    assert content["properties_uuid"][prop_uuid] == open_uuid


@pytest.mark.asyncio
async def test_delete_required_property_without_default_rejected(auth_client: AsyncClient):
    """DELETE on an effective-required property without a default → 400."""
    prop_resp = await auth_client.post("/api/properties/", json={
        "name": "DelReqNoDefault", "type": "selection", "scope": "global",
        "selection_lines": ["A", "B"],
    })
    prop = prop_resp.json()
    prop_uuid = prop["property_uuid"]
    a_uuid = prop["options"][0]["selection_line_uuid"]
    await auth_client.put(f"/api/properties/{prop_uuid}", json={"required": True})
    node_uuid = (await auth_client.post("/api/nodes/", json={"name": "N8"})).json()["uuid"]
    r = await auth_client.post(f"/api/nodes/{node_uuid}/properties",
                               json={"property_uuid": prop_uuid, "value": a_uuid})
    assert r.status_code == 200, r.text

    r = await auth_client.delete(f"/api/nodes/{node_uuid}/properties/{prop_uuid}")
    assert r.status_code == 400
    assert r.json()["detail"]["code"] == "required_property"
    # value untouched
    content = (await auth_client.get(f"/api/nodes/page/{node_uuid}/content")).json()
    assert content["properties_uuid"][prop_uuid] == a_uuid


@pytest.mark.asyncio
async def test_class_assignment_applies_property_level_default(auth_client: AsyncClient):
    """A class edge without its own default inherits the property-level default."""
    prop_resp = await auth_client.post("/api/properties/", json={
        "name": "DefaultedBool", "type": "boolean", "scope": "global",
    })
    assert prop_resp.status_code == 200, prop_resp.text
    prop_uuid = prop_resp.json()["property_uuid"]
    put_resp = await auth_client.put(f"/api/properties/{prop_uuid}", json={"default_value": True})
    assert put_resp.status_code == 200, put_resp.text

    class_uuid = (await auth_client.post(
        "/api/nodes/", json={"name": "Default Class", "is_class": True}
    )).json()["uuid"]
    await auth_client.post(f"/api/properties/classes/{class_uuid}/properties",
                           json={"property_uuid": prop_uuid})

    node_uuid = (await auth_client.post("/api/nodes/", json={"name": "DN"})).json()["uuid"]
    add_resp = await auth_client.post(f"/api/nodes/{node_uuid}/classes",
                                      json={"class_node_uuid": class_uuid})
    assert add_resp.status_code == 200, add_resp.text

    content = (await auth_client.get(f"/api/nodes/page/{node_uuid}/content")).json()
    assert content["properties_uuid"][prop_uuid] is True


@pytest.mark.asyncio
async def test_system_task_status_is_required_with_pending_default(auth_client: AsyncClient):
    """The seeded task-status property carries required + Pending default."""
    from app.domain.entities.constants import SYSTEM_PROPERTY_UUIDS

    resp = await auth_client.get(
        f"/api/properties/uuid/{SYSTEM_PROPERTY_UUIDS['task_status']}"
    )
    assert resp.status_code == 200, resp.text
    prop = resp.json()
    assert prop["required"] is True
    pending = next(
        (o for o in prop["options"] if o["name"] == "Pending"), None
    )
    assert pending is not None
    assert prop["default_value"] == pending["selection_line_uuid"]


@pytest.mark.asyncio
async def test_new_workspace_seed_keeps_own_task_status_default(
    auth_client: AsyncClient, test_user: dict, db_pool
):
    """Seeding a second workspace must not repoint the first workspace's
    task-status default_selection_id (the seed must key its UPDATE on the
    per-workspace property row id, not the shared system property UUID)."""
    import secrets

    from app.domain.entities.constants import SYSTEM_PROPERTY_UUIDS

    status_uuid = SYSTEM_PROPERTY_UUIDS["task_status"]
    first_ws_id = test_user["workspace_id"]

    # Baseline: the first workspace's default is its own Pending line.
    resp = await auth_client.get(f"/api/properties/uuid/{status_uuid}")
    assert resp.status_code == 200, resp.text
    prop = resp.json()
    pending = next(o for o in prop["options"] if o["name"] == "Pending")
    assert prop["default_value"] == pending["selection_line_uuid"]
    first_pending_uuid = pending["selection_line_uuid"]

    # Seed a second workspace (seed_workspace runs at runtime on creation).
    ws_resp = await auth_client.post(
        "/api/workspaces/", json={"name": f"ws2_{secrets.token_hex(4)}"}
    )
    assert ws_resp.status_code == 200, ws_resp.text

    # The first workspace's property row must still point at its own Pending line.
    row = await db_pool.fetchrow(
        """
        SELECT p.default_selection_id,
               own.id AS own_pending_id,
               own.uuid::text AS own_pending_uuid
        FROM property p
        LEFT JOIN property_selection_line own
          ON own.property_id = p.id AND own.name = 'Pending'
        WHERE p.workspace_id = $1 AND p.uuid = $2
        """,
        first_ws_id,
        status_uuid,
    )
    assert row is not None
    assert row["own_pending_id"] is not None
    assert row["default_selection_id"] == row["own_pending_id"]
    assert row["own_pending_uuid"] == first_pending_uuid


@pytest.mark.asyncio
async def test_schema_rerun_preserves_explicit_false_override(
    auth_client: AsyncClient, db_pool, database_url: str
):
    """An explicit required=false override must survive a schema re-run.

    SCHEMA_SQL executes at every backend startup; the legacy false->NULL
    backfill must be a one-time upgrade, not a per-startup wipe of the
    tri-state "force off" overrides the UI now lets users set.
    """
    prop_uuid = (await auth_client.post("/api/properties/", json={
        "name": "OverrideProp", "type": "boolean", "scope": "global",
    })).json()["property_uuid"]
    class_uuid = (await auth_client.post(
        "/api/nodes/", json={"name": "Override Class", "is_class": True}
    )).json()["uuid"]
    add_resp = await auth_client.post(
        f"/api/properties/classes/{class_uuid}/properties",
        json={"property_uuid": prop_uuid},
    )
    assert add_resp.status_code == 200, add_resp.text

    r = await auth_client.patch(
        f"/api/properties/classes/{class_uuid}/properties/{prop_uuid}",
        json={"required": False},
    )
    assert r.status_code == 200, r.text
    assert r.json()["required"] is False

    # Simulate a container restart: schema SQL runs again.
    await _rerun_startup_schema(database_url)

    assert await _class_property_required(db_pool, class_uuid, prop_uuid) is False


@pytest.mark.asyncio
async def test_schema_rerun_converts_legacy_false_rows_on_first_upgrade(
    auth_client: AsyncClient, db_pool, database_url: str
):
    """A genuine first-time upgrade still converts legacy false rows to NULL.

    Simulated by restoring the pre-upgrade column state (DEFAULT FALSE plus a
    false row); the next schema run must convert the row to NULL (inherit) and
    drop the default again, so later runs are no-ops.
    """
    prop_uuid = (await auth_client.post("/api/properties/", json={
        "name": "LegacyProp", "type": "boolean", "scope": "global",
    })).json()["property_uuid"]
    class_uuid = (await auth_client.post(
        "/api/nodes/", json={"name": "Legacy Class", "is_class": True}
    )).json()["uuid"]
    add_resp = await auth_client.post(
        f"/api/properties/classes/{class_uuid}/properties",
        json={"property_uuid": prop_uuid},
    )
    assert add_resp.status_code == 200, add_resp.text

    # Restore the pre-upgrade state: legacy default + a row that is FALSE
    # only because the old column defaulted to FALSE.
    await db_pool.execute(
        "ALTER TABLE class_property ALTER COLUMN required SET DEFAULT FALSE"
    )
    await db_pool.execute(
        """
        UPDATE class_property cp SET required = FALSE
        FROM node c, property p
        WHERE c.id = cp.class_node_id AND p.id = cp.property_id
          AND c.uuid = $1 AND p.uuid = $2
        """,
        class_uuid,
        prop_uuid,
    )

    await _rerun_startup_schema(database_url)

    assert await _class_property_required(db_pool, class_uuid, prop_uuid) is None
    column_default = await db_pool.fetchval(
        """
        SELECT column_default
        FROM information_schema.columns
        WHERE table_name = 'class_property' AND column_name = 'required'
        """
    )
    assert column_default is None, "upgrade must drop the legacy default again"


@pytest.mark.asyncio
async def test_required_text_clear_resets_to_text_default(
    auth_client: AsyncClient, db_pool
):
    """Clearing a required TEXT property with a text default resets to a text
    node holding the default (was 400: the raw default_text string hit the
    relation dispatch, which expects an internal node id)."""
    prop_resp = await auth_client.post("/api/properties/", json={
        "name": "ReqText", "type": "text", "scope": "global",
    })
    assert prop_resp.status_code == 200, prop_resp.text
    prop_uuid = prop_resp.json()["property_uuid"]
    r = await auth_client.put(
        f"/api/properties/{prop_uuid}",
        json={"required": True, "default_value": "Default body"},
    )
    assert r.status_code == 200, r.text
    assert r.json()["default_value"] == "Default body"

    node_uuid = (await auth_client.post("/api/nodes/", json={"name": "NT"})).json()["uuid"]

    r = await auth_client.post(
        f"/api/nodes/{node_uuid}/properties",
        json={"property_uuid": prop_uuid, "value": None},
    )
    assert r.status_code == 200, r.text

    name = await _text_value_node_name(db_pool, node_uuid, prop_uuid)
    assert name is not None, "clear must materialize a text node from the default"
    assert _plain_text(name) == "Default body"


@pytest.mark.asyncio
async def test_delete_required_text_property_resets_to_text_default(
    auth_client: AsyncClient, db_pool
):
    """DELETE on a required TEXT property with a text default resets to the
    default (was 500: ValueError escaped the DELETE router)."""
    prop_resp = await auth_client.post("/api/properties/", json={
        "name": "DelReqText", "type": "text", "scope": "global",
    })
    assert prop_resp.status_code == 200, prop_resp.text
    prop_uuid = prop_resp.json()["property_uuid"]
    r = await auth_client.put(
        f"/api/properties/{prop_uuid}",
        json={"required": True, "default_value": "Delete default"},
    )
    assert r.status_code == 200, r.text
    node_uuid = (await auth_client.post("/api/nodes/", json={"name": "NTD"})).json()["uuid"]
    r = await auth_client.post(
        f"/api/nodes/{node_uuid}/properties",
        json={"property_uuid": prop_uuid, "value": None},
    )
    assert r.status_code == 200, r.text

    r = await auth_client.delete(f"/api/nodes/{node_uuid}/properties/{prop_uuid}")
    assert r.status_code == 200, r.text

    name = await _text_value_node_name(db_pool, node_uuid, prop_uuid)
    assert name is not None
    assert _plain_text(name) == "Delete default"


@pytest.mark.asyncio
async def test_required_text_clear_without_default_rejected(auth_client: AsyncClient):
    """Required TEXT property without a default still rejects clears."""
    prop_resp = await auth_client.post("/api/properties/", json={
        "name": "ReqTextNoDefault", "type": "text", "scope": "global",
    })
    assert prop_resp.status_code == 200, prop_resp.text
    prop_uuid = prop_resp.json()["property_uuid"]
    r = await auth_client.put(f"/api/properties/{prop_uuid}", json={"required": True})
    assert r.status_code == 200, r.text
    node_uuid = (await auth_client.post("/api/nodes/", json={"name": "NTX"})).json()["uuid"]

    r = await auth_client.post(
        f"/api/nodes/{node_uuid}/properties",
        json={"property_uuid": prop_uuid, "value": None},
    )
    assert r.status_code == 400
    assert r.json()["detail"]["code"] == "required_property"

    r = await auth_client.delete(f"/api/nodes/{node_uuid}/properties/{prop_uuid}")
    assert r.status_code == 400
    assert r.json()["detail"]["code"] == "required_property"
