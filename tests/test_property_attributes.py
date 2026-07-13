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
