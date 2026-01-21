"""Tests for node CRUD operations.

These tests verify node creation, reading, updating, and deletion.
"""
import pytest
from httpx import AsyncClient


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
            "/api/nodes",
            json=sample_node_data
        )
        assert response.status_code == 200
        
        data = response.json()
        assert "id" in data
        assert "uuid" in data
        # For pages, the name is derived from the input
        assert data.get("name") == sample_node_data["name"]

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
            "/api/nodes",
            json=sample_node_data
        )
        page = page_response.json()
        
        # Then create a block under it
        sample_block_data["parent_id"] = page["id"]
        block_response = await authenticated_client.post(
            "/api/nodes",
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
        assert data.get("is_daily") == True


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
            "/api/nodes",
            json=sample_node_data
        )
        node = create_response.json()
        
        # Retrieve it
        get_response = await authenticated_client.get(f"/api/nodes/{node['id']}")
        assert get_response.status_code == 200
        
        retrieved = get_response.json()
        assert retrieved["id"] == node["id"]

    @pytest.mark.asyncio
    async def test_get_nonexistent_node(self, authenticated_client: AsyncClient):
        """Test retrieving a node that doesn't exist."""
        response = await authenticated_client.get("/api/nodes/999999")
        assert response.status_code == 404

    @pytest.mark.asyncio
    async def test_list_nodes(
        self,
        authenticated_client: AsyncClient,
        sample_node_data: dict
    ):
        """Test listing all nodes."""
        # Create a node first
        await authenticated_client.post("/api/nodes", json=sample_node_data)
        
        # List nodes
        response = await authenticated_client.get("/api/nodes")
        assert response.status_code == 200
        
        data = response.json()
        assert "nodes" in data
        assert isinstance(data["nodes"], list)


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
            "/api/nodes",
            json=sample_node_data
        )
        node = create_response.json()
        
        # Update it - use name field
        update_response = await authenticated_client.put(
            f"/api/nodes/{node['id']}",
            json={"name": "Updated content"}
        )
        assert update_response.status_code == 200
        
        updated = update_response.json()
        assert updated.get("name") == "Updated content"


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
            "/api/nodes",
            json=sample_node_data
        )
        node = create_response.json()
        
        # Delete it
        delete_response = await authenticated_client.delete(f"/api/nodes/{node['id']}")
        assert delete_response.status_code == 200
        
        # Verify it's gone
        get_response = await authenticated_client.get(f"/api/nodes/{node['id']}")
        assert get_response.status_code == 404
