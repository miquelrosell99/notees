"""Tests for the template instantiation system.

Tests the three new endpoints:
  GET  /api/nodes/templates
  GET  /api/nodes/{id}/template-variables
  POST /api/nodes/{id}/instantiate
"""
import pytest
from httpx import AsyncClient

from app.db.schema import SYSTEM_CLASS_UUIDS

pytestmark = pytest.mark.integration


async def _get_template_class_uuid(authenticated_client: AsyncClient) -> str:
    """Look up the template system class node UUID."""
    resp = await authenticated_client.get("/api/nodes/classes")
    assert resp.status_code == 200
    classes = resp.json().get("nodes", [])
    for cls in classes:
        if cls.get("uuid") == SYSTEM_CLASS_UUIDS["template"]:
            return cls["uuid"]
    pytest.fail("Template system class not found in workspace")


async def _create_node(authenticated_client: AsyncClient, **kwargs) -> dict:
    """Create a node via POST /api/nodes/ (requires trailing slash)."""
    resp = await authenticated_client.post("/api/nodes/", json=kwargs)
    assert resp.status_code == 200, f"create_node failed: {resp.text}"
    return resp.json()


async def _create_template_page(authenticated_client: AsyncClient, name: str) -> dict:
    """Create a node and assign the template class to it."""
    node = await _create_node(authenticated_client, name=name)

    # Add template class
    template_class_uuid = await _get_template_class_uuid(authenticated_client)
    resp = await authenticated_client.post(
        f"/api/nodes/{node['uuid']}/classes",
        json={"class_node_uuid": template_class_uuid},
    )
    assert resp.status_code == 200, resp.text
    return resp.json()


class TestListTemplates:
    """Tests for GET /api/nodes/templates"""

    @pytest.mark.asyncio
    async def test_returns_empty_list_initially(self, authenticated_client: AsyncClient):
        resp = await authenticated_client.get("/api/nodes/templates")
        assert resp.status_code == 200
        data = resp.json()
        assert "items" in data
        assert "total" in data
        assert isinstance(data["items"], list)
        assert data["total"] == 0

    @pytest.mark.asyncio
    async def test_returns_template_after_creation(self, authenticated_client: AsyncClient):
        await _create_template_page(authenticated_client, "My Template")

        resp = await authenticated_client.get("/api/nodes/templates")
        assert resp.status_code == 200
        data = resp.json()
        assert data["total"] == 1
        assert data["items"][0]["name"] is not None

    @pytest.mark.asyncio
    async def test_non_template_pages_not_listed(self, authenticated_client: AsyncClient):
        # Create a plain page (no template class)
        await _create_node(authenticated_client, name="Plain Page")

        # Create one template
        await _create_template_page(authenticated_client, "Template One")

        resp = await authenticated_client.get("/api/nodes/templates")
        assert resp.status_code == 200
        data = resp.json()
        assert data["total"] == 1


class TestGetTemplateVariables:
    """Tests for GET /api/nodes/{id}/template-variables"""

    @pytest.mark.asyncio
    async def test_no_variables_in_plain_template(self, authenticated_client: AsyncClient):
        template = await _create_template_page(authenticated_client, "Plain template")

        resp = await authenticated_client.get(
            f"/api/nodes/{template['uuid']}/template-variables"
        )
        assert resp.status_code == 200
        data = resp.json()
        assert data["variables"] == []

    @pytest.mark.asyncio
    async def test_extracts_variables_from_name(self, authenticated_client: AsyncClient):
        # Create a template with {{variable}} in its name content
        node = await _create_node(
            authenticated_client, name="Hello {{recipient}} from {{sender}}"
        )

        template_class_uuid = await _get_template_class_uuid(authenticated_client)
        await authenticated_client.post(
            f"/api/nodes/{node['uuid']}/classes",
            json={"class_node_uuid": template_class_uuid},
        )

        resp = await authenticated_client.get(
            f"/api/nodes/{node['uuid']}/template-variables"
        )
        assert resp.status_code == 200
        variables = resp.json()["variables"]
        assert "recipient" in variables
        assert "sender" in variables

    @pytest.mark.asyncio
    async def test_returns_422_for_non_template(self, authenticated_client: AsyncClient):
        node = await _create_node(authenticated_client, name="Not a template")

        resp = await authenticated_client.get(
            f"/api/nodes/{node['uuid']}/template-variables"
        )
        assert resp.status_code == 422

    @pytest.mark.asyncio
    async def test_returns_404_for_missing_node(self, authenticated_client: AsyncClient):
        resp = await authenticated_client.get("/api/nodes/00000000-0000-0000-0000-000000099999/template-variables")
        assert resp.status_code == 404


class TestInstantiateTemplate:
    """Tests for POST /api/nodes/{id}/instantiate"""

    @pytest.mark.asyncio
    async def test_instantiate_creates_new_page(self, authenticated_client: AsyncClient):
        template = await _create_template_page(authenticated_client, "My Template")

        resp = await authenticated_client.post(
            f"/api/nodes/{template['uuid']}/instantiate",
            json={"as_blocks": False},
        )
        assert resp.status_code == 200, resp.text
        data = resp.json()
        assert data["as_blocks"] is False
        assert data["node"] is not None
        # New node should NOT be the same as template
        assert data["node"]["id"] != template["id"]

    @pytest.mark.asyncio
    async def test_new_node_lacks_template_class(self, authenticated_client: AsyncClient):
        template = await _create_template_page(authenticated_client, "My Template")

        resp = await authenticated_client.post(
            f"/api/nodes/{template['uuid']}/instantiate",
            json={"as_blocks": False},
        )
        data = resp.json()
        new_node = data["node"]

        # Fetch details of the new node
        detail = await authenticated_client.get(f"/api/nodes/{new_node['uuid']}")
        assert detail.status_code == 200
        # is_template must be False on the copy
        assert detail.json().get("is_template") is not True

    @pytest.mark.asyncio
    async def test_variable_substitution(self, authenticated_client: AsyncClient):
        # Create template with {{variable}}
        node = await _create_node(authenticated_client, name="Hello {{name}}")
        template_class_uuid = await _get_template_class_uuid(authenticated_client)
        await authenticated_client.post(
            f"/api/nodes/{node['uuid']}/classes",
            json={"class_node_uuid": template_class_uuid},
        )

        resp = await authenticated_client.post(
            f"/api/nodes/{node['uuid']}/instantiate",
            json={"variables": {"name": "World"}, "as_blocks": False},
        )
        assert resp.status_code == 200
        new_node = resp.json()["node"]
        assert "World" in (new_node.get("name") or "")
        assert "{{name}}" not in (new_node.get("name") or "")

    @pytest.mark.asyncio
    async def test_as_blocks_mode_returns_blocks(self, authenticated_client: AsyncClient):
        # Create a parent page for blocks to live in
        parent = await _create_node(authenticated_client, name="Parent Page")

        # Create template with one child block
        template = await _create_template_page(authenticated_client, "Block Template")
        await _create_node(
            authenticated_client, name="child block content", parent_uuid=template["uuid"]
        )

        resp = await authenticated_client.post(
            f"/api/nodes/{template['uuid']}/instantiate",
            json={"parent_uuid": parent["uuid"], "as_blocks": True},
        )
        assert resp.status_code == 200
        data = resp.json()
        assert data["as_blocks"] is True
        assert data["node"] is None
        assert isinstance(data["blocks"], list)
        assert len(data["blocks"]) >= 1

    @pytest.mark.asyncio
    async def test_returns_422_for_non_template(self, authenticated_client: AsyncClient):
        node = await _create_node(authenticated_client, name="Not a template")

        resp = await authenticated_client.post(
            f"/api/nodes/{node['uuid']}/instantiate",
            json={"as_blocks": False},
        )
        assert resp.status_code == 422

    @pytest.mark.asyncio
    async def test_returns_404_for_missing_node(self, authenticated_client: AsyncClient):
        resp = await authenticated_client.post(
            "/api/nodes/00000000-0000-0000-0000-000000099999/instantiate",
            json={"as_blocks": False},
        )
        assert resp.status_code == 404
