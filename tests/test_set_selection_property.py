"""Regression test for selection property 500 error.

Covers the bug where setting any property value caused a 500 because activity
logging passed the property ID to the ``node_activity.target_node_id`` column,
which has a foreign-key constraint to ``node(id)``.
"""

import pytest
from httpx import AsyncClient


@pytest.mark.asyncio
async def test_set_selection_property_on_page(auth_client: AsyncClient):
    """Setting a selection property value on a page should return 200."""
    # Create a page
    page_resp = await auth_client.post("/api/nodes/", json={
        "name": "Test Page",
        "is_page": True,
    })
    assert page_resp.status_code == 200, page_resp.text
    page = page_resp.json()
    page_uuid = page["uuid"]

    # Create a selection property with options
    prop_resp = await auth_client.post("/api/properties/", json={
        "name": "MyTestStatus",
        "type": "selection",
        "scope": "global",
        "is_multi": False,
        "selection_lines": ["Todo", "Done"],
    })
    assert prop_resp.status_code == 200, prop_resp.text
    prop = prop_resp.json()
    prop_uuid = prop["property_uuid"]
    options = prop["options"]
    assert len(options) == 2
    option_uuid = options[0]["selection_line_uuid"]

    # Set the selection property value on the page
    set_resp = await auth_client.post(f"/api/nodes/{page_uuid}/properties", json={
        "property_uuid": prop_uuid,
        "value": option_uuid,
    })
    assert set_resp.status_code == 200, set_resp.text
    data = set_resp.json()
    assert data["properties"][prop_uuid] == option_uuid

    # Refetch page content and confirm the value is returned as a public UUID.
    content_resp = await auth_client.get(f"/api/nodes/page/{page_uuid}/content")
    assert content_resp.status_code == 200, content_resp.text
    content = content_resp.json()
    assert content["properties_uuid"][prop_uuid] == option_uuid
