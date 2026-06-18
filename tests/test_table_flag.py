"""Tests for the is_table flag synchronization.

Tests that node.is_table stays synchronized with the table class assignment.
"""
import pytest
from httpx import AsyncClient

from app.db.schema import SYSTEM_CLASS_UUIDS

pytestmark = pytest.mark.integration


async def _get_table_class_id(authenticated_client: AsyncClient) -> int:
    """Look up the table system class node ID."""
    resp = await authenticated_client.get("/api/nodes/classes")
    assert resp.status_code == 200
    classes = resp.json().get("nodes", [])
    for cls in classes:
        if cls.get("uuid") == SYSTEM_CLASS_UUIDS["table"]:
            return cls["id"]
    pytest.fail("Table system class not found in workspace")


async def _create_node(authenticated_client: AsyncClient, **kwargs) -> dict:
    """Create a node via POST /api/nodes/."""
    resp = await authenticated_client.post("/api/nodes/", json=kwargs)
    assert resp.status_code == 200, f"create_node failed: {resp.text}"
    return resp.json()


class TestIsTableFlag:
    """Tests that node.is_table stays synchronized with the table class assignment."""

    @pytest.mark.asyncio
    async def test_is_table_set_on_creation_with_table_class(
        self, authenticated_client: AsyncClient
    ):
        table_class_id = await _get_table_class_id(authenticated_client)
        table = await _create_node(
            authenticated_client, name="Table on Create", classes=[table_class_id]
        )
        assert table.get("is_table") is True

        resp = await authenticated_client.get(f"/api/nodes/{table['id']}")
        assert resp.status_code == 200
        assert resp.json().get("is_table") is True

    @pytest.mark.asyncio
    async def test_is_table_false_without_table_class(
        self, authenticated_client: AsyncClient
    ):
        page = await _create_node(authenticated_client, name="Plain Page")
        assert page.get("is_table") is False

    @pytest.mark.asyncio
    async def test_is_table_set_when_adding_table_class(
        self, authenticated_client: AsyncClient
    ):
        page = await _create_node(authenticated_client, name="Becomes Table")
        assert page.get("is_table") is False

        table_class_id = await _get_table_class_id(authenticated_client)
        resp = await authenticated_client.post(
            f"/api/nodes/{page['id']}/classes",
            json={"class_node_id": table_class_id},
        )
        assert resp.status_code == 200
        assert resp.json().get("is_table") is True

    @pytest.mark.asyncio
    async def test_is_table_cleared_when_removing_table_class(
        self, authenticated_client: AsyncClient
    ):
        table_class_id = await _get_table_class_id(authenticated_client)
        table = await _create_node(
            authenticated_client, name="Former Table", classes=[table_class_id]
        )
        assert table.get("is_table") is True

        resp = await authenticated_client.delete(
            f"/api/nodes/{table['id']}/classes/{table_class_id}"
        )
        assert resp.status_code == 200
        assert resp.json().get("is_table") is False
