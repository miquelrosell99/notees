"""Test that template instantiation copies ALL children, not just the first."""
import pytest
from httpx import AsyncClient

from app.db.schema import SYSTEM_CLASS_UUIDS

pytestmark = pytest.mark.integration


async def _get_template_class_uuid(c: AsyncClient) -> str:
    resp = await c.get("/api/nodes/classes")
    for cls in resp.json().get("nodes", []):
        if cls.get("uuid") == SYSTEM_CLASS_UUIDS["template"]:
            return cls["uuid"]
    raise Exception("Template class not found")


async def _create_node(c: AsyncClient, **kw) -> dict:
    resp = await c.post("/api/nodes/", json=kw)
    assert resp.status_code == 200, resp.text
    return resp.json()


@pytest.mark.asyncio
async def test_multi_child_as_blocks(authenticated_client: AsyncClient):
    """Template with 3 children + 1 grandchild should produce 4 blocks."""
    c = authenticated_client

    # Create template page
    template = await _create_node(c, name="Multi Child Template")
    tc_uuid = await _get_template_class_uuid(c)
    await c.post(f"/api/nodes/{template['uuid']}/classes", json={"class_node_uuid": tc_uuid})

    # Create 3 child blocks under the template
    child1 = await _create_node(c, name="Child 1", parent_uuid=template["uuid"], sequence=0)
    await _create_node(c, name="Child 2", parent_uuid=template["uuid"], sequence=1)
    await _create_node(c, name="Child 3", parent_uuid=template["uuid"], sequence=2)

    # Add a grandchild under child1
    await _create_node(c, name="Grandchild 1", parent_uuid=child1["uuid"], sequence=0)

    # Create a target page
    parent = await _create_node(c, name="Target Page")

    # Instantiate as blocks
    resp = await c.post(
        f"/api/nodes/{template['uuid']}/instantiate",
        json={"parent_id": parent["id"], "as_blocks": True},
    )
    assert resp.status_code == 200, resp.text
    data = resp.json()

    print(f"blocks returned: {len(data['blocks'])}")
    for b in data["blocks"]:
        print(f"  id={b['id']} parent_id={b['parent_id']} name={str(b.get('name',''))[:50]}")

    # Should have 4 blocks total (3 children + 1 grandchild)
    assert len(data["blocks"]) == 4, f"Expected 4 blocks, got {len(data['blocks'])}"

    # 3 direct children should have parent_id == parent page
    direct = [b for b in data["blocks"] if b["parent_id"] == parent["id"]]
    assert len(direct) == 3, f"Expected 3 direct children, got {len(direct)}"
