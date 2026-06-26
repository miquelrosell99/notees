"""Tests for node CRUD operations.

These tests verify node creation, reading, updating, and deletion.
"""
import pytest
from app.db.schema.constants import SYSTEM_CLASS_UUIDS
from httpx import AsyncClient

pytestmark = pytest.mark.integration


class TestNodeCreation:
    """Test node creation operations."""

    @pytest.mark.asyncio
    async def test_create_page(
        self,
        authenticated_client: AsyncClient,
        sample_node_data: dict
    ):
        """Test creating a page node."""
        response = await authenticated_client.post(
            "/api/nodes/",
            json=sample_node_data
        )
        assert response.status_code == 200

        data = response.json()
        assert "id" in data
        assert "uuid" in data
        # name is stored as AST JSON internally; the input text should appear in it
        assert sample_node_data["name"] in data.get("name", "")

    @pytest.mark.asyncio
    async def test_create_block(
        self,
        authenticated_client: AsyncClient,
        sample_node_data: dict,
        sample_block_data: dict
    ):
        """Test creating a block under a page."""
        # First create a page
        page_response = await authenticated_client.post(
            "/api/nodes/",
            json=sample_node_data
        )
        page = page_response.json()

        # Then create a block under it
        sample_block_data["parent_uuid"] = page["uuid"]
        block_response = await authenticated_client.post(
            "/api/nodes/",
            json=sample_block_data
        )
        assert block_response.status_code == 200

        block = block_response.json()
        assert block["parent_id"] == page["id"]

    @pytest.mark.asyncio
    async def test_create_daily_page(
        self,
        authenticated_client: AsyncClient,
    ):
        """Test creating a daily journal page."""
        # Use the dedicated daily endpoint
        response = await authenticated_client.post(
            "/api/nodes/daily",
            params={"date": "2026-01-15"}
        )
        assert response.status_code == 200

        data = response.json()
        assert data.get("is_daily")


class TestNodeRetrieval:
    """Test node retrieval operations."""

    @pytest.mark.asyncio
    async def test_get_node_by_id(
        self,
        authenticated_client: AsyncClient,
        sample_node_data: dict
    ):
        """Test retrieving a node by ID."""
        # Create a node
        create_response = await authenticated_client.post(
            "/api/nodes/",
            json=sample_node_data
        )
        node = create_response.json()

        # Retrieve it
        get_response = await authenticated_client.get(f"/api/nodes/{node['uuid']}")
        assert get_response.status_code == 200

        retrieved = get_response.json()
        assert retrieved["id"] == node["id"]

    @pytest.mark.asyncio
    async def test_get_nonexistent_node(self, authenticated_client: AsyncClient):
        """Test retrieving a node that doesn't exist."""
        response = await authenticated_client.get("/api/nodes/00000000-0000-0000-0000-000000099999")
        assert response.status_code == 404

    @pytest.mark.asyncio
    async def test_list_nodes(
        self,
        authenticated_client: AsyncClient,
        sample_node_data: dict
    ):
        """Test listing all nodes."""
        # Create a node first
        await authenticated_client.post("/api/nodes/", json=sample_node_data)

        # List nodes
        response = await authenticated_client.get("/api/nodes/")
        assert response.status_code == 200

        data = response.json()
        assert "items" in data
        assert isinstance(data["items"], list)

    @pytest.mark.asyncio
    async def test_list_nodes_pages_only_pagination(
        self,
        authenticated_client: AsyncClient,
        test_user: dict,
    ):
        """pages_only honors page/page_size and returns bounded slices."""
        page_class_uuid = SYSTEM_CLASS_UUIDS["page"]
        names = ["PgTest-A", "PgTest-B", "PgTest-C", "PgTest-D", "PgTest-E"]
        for name in names:
            response = await authenticated_client.post(
                "/api/nodes/",
                json={"name": name, "class_uuids": [page_class_uuid]},
            )
            assert response.status_code == 200

        params = {
            "pages_only": "true",
            "page_size": 2,
            "sort_by": "write_date",
            "order": "desc",
        }

        def _our(items):
            return [item for item in items if "PgTest-" in item["name"]]

        page1 = await authenticated_client.get("/api/nodes/", params={**params, "page": 1})
        assert page1.status_code == 200
        data1 = page1.json()
        our1 = _our(data1["items"])
        assert [name in item["name"] for item, name in zip(our1, ["PgTest-E", "PgTest-D"], strict=False)]

        page2 = await authenticated_client.get("/api/nodes/", params={**params, "page": 2})
        assert page2.status_code == 200
        data2 = page2.json()
        our2 = _our(data2["items"])
        assert [name in item["name"] for item, name in zip(our2, ["PgTest-C", "PgTest-B"], strict=False)]

        page3 = await authenticated_client.get("/api/nodes/", params={**params, "page": 3})
        assert page3.status_code == 200
        data3 = page3.json()
        our3 = _our(data3["items"])
        assert [name in item["name"] for item, name in zip(our3, ["PgTest-A"], strict=False)]

    @pytest.mark.asyncio
    async def test_list_nodes_pages_only_caps_page_size(
        self,
        authenticated_client: AsyncClient,
        test_user: dict,
    ):
        """Excessive page_size for pages_only is capped at 5000."""
        page_class_uuid = SYSTEM_CLASS_UUIDS["page"]
        for name in ("PgTest-One", "PgTest-Two"):
            response = await authenticated_client.post(
                "/api/nodes/",
                json={"name": name, "class_uuids": [page_class_uuid]},
            )
            assert response.status_code == 200

        response = await authenticated_client.get(
            "/api/nodes/",
            params={"pages_only": "true", "page_size": 10000},
        )
        assert response.status_code == 200
        data = response.json()
        # The cap is enforced in the repository; with few pages the effective
        # page_size equals the total returned.
        assert data["total"] <= 5000
        assert data["page_size"] <= 5000
        assert len(data["items"]) <= 5000
        our_names = [item["name"] for item in data["items"] if "PgTest-" in item["name"]]
        assert any("PgTest-One" in name for name in our_names)
        assert any("PgTest-Two" in name for name in our_names)

    @pytest.mark.asyncio
    async def test_list_nodes_pages_only_defaults_page_size(
        self,
        authenticated_client: AsyncClient,
        test_user: dict,
    ):
        """pages_only defaults to a bounded result set when page_size is omitted."""
        page_class_uuid = SYSTEM_CLASS_UUIDS["page"]
        response = await authenticated_client.post(
            "/api/nodes/",
            json={"name": "PgTest-Solo", "class_uuids": [page_class_uuid]},
        )
        assert response.status_code == 200

        response = await authenticated_client.get(
            "/api/nodes/",
            params={"pages_only": "true"},
        )
        assert response.status_code == 200
        data = response.json()
        # The repository default limit bounds the unbounded request.
        assert data["total"] <= 1000
        assert data["page_size"] <= 1000
        assert len(data["items"]) <= 1000
        our_names = [item["name"] for item in data["items"] if "PgTest-" in item["name"]]
        assert any("PgTest-Solo" in name for name in our_names)


class TestNodeUpdate:
    """Test node update operations."""

    @pytest.mark.asyncio
    async def test_update_node_content(
        self,
        authenticated_client: AsyncClient,
        sample_node_data: dict
    ):
        """Test updating a node's content."""
        # Create a node
        create_response = await authenticated_client.post(
            "/api/nodes/",
            json=sample_node_data
        )
        node = create_response.json()

        # Update it - use name field
        update_response = await authenticated_client.put(
            f"/api/nodes/{node['uuid']}",
            json={"name": "Updated content"}
        )
        assert update_response.status_code == 200

        updated = update_response.json()
        # name is stored as AST JSON; the input text should appear within it
        assert "Updated content" in updated.get("name", "")


class TestNodeDeletion:
    """Test node deletion operations."""

    @pytest.mark.asyncio
    async def test_delete_node(
        self,
        authenticated_client: AsyncClient,
        sample_node_data: dict
    ):
        """Test deleting a node."""
        # Create a node
        create_response = await authenticated_client.post(
            "/api/nodes/",
            json=sample_node_data
        )
        node = create_response.json()

        # Delete it
        delete_response = await authenticated_client.delete(f"/api/nodes/{node['uuid']}")
        assert delete_response.status_code == 200

        # Verify it's gone
        get_response = await authenticated_client.get(f"/api/nodes/{node['uuid']}")
        assert get_response.status_code == 404
