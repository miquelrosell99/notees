"""Integration tests for property attributes (required/default/readonly/hide-when-empty)."""

import pytest
from httpx import AsyncClient


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
