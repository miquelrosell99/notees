"""Tests for batch node create and update operations.

These tests verify the /api/nodes/batch endpoints for bulk
node creation and updating — useful for Logseq / EDN imports.
"""
import pytest
from httpx import AsyncClient


class TestBatchCreate:
    """Test batch node creation."""

    @pytest.mark.asyncio
    async def test_batch_create_multiple_blocks(
        self,
        authenticated_client: AsyncClient,
        sample_node_data: dict,
    ):
        """Create a page, then batch-create several blocks under it."""
        # Create a parent page first
        page_resp = await authenticated_client.post("/api/nodes/", json=sample_node_data)
        assert page_resp.status_code == 200
        page = page_resp.json()

        # Batch create 3 blocks under the page
        batch_payload = {
            "nodes": [
                {"name": "Block 1", "parent_id": page["id"], "sequence": 0},
                {"name": "Block 2", "parent_id": page["id"], "sequence": 1},
                {"name": "Block 3", "parent_id": page["id"], "sequence": 2},
            ]
        }
        resp = await authenticated_client.post("/api/nodes/batch", json=batch_payload)
        assert resp.status_code == 200

        data = resp.json()
        assert data["created"] == 3
        assert data["failed"] == 0
        assert len(data["results"]) == 3
        for i, result in enumerate(data["results"]):
            assert result["success"] is True
            assert result["index"] == i
            assert result["node"] is not None
            assert result["node"]["parent_id"] == page["id"]

    @pytest.mark.asyncio
    async def test_batch_create_empty_list(
        self,
        authenticated_client: AsyncClient,
    ):
        """Empty batch should succeed with zero counts."""
        resp = await authenticated_client.post("/api/nodes/batch", json={"nodes": []})
        assert resp.status_code == 200
        data = resp.json()
        assert data["created"] == 0
        assert data["failed"] == 0
        assert data["results"] == []

    @pytest.mark.asyncio
    async def test_batch_create_with_uuid(
        self,
        authenticated_client: AsyncClient,
        sample_node_data: dict,
    ):
        """Batch create nodes with custom UUIDs (e.g. from Logseq)."""
        page_resp = await authenticated_client.post("/api/nodes/", json=sample_node_data)
        page = page_resp.json()

        custom_uuid = "aaaabbbb-cccc-dddd-eeee-ffffffffffff"
        batch_payload = {
            "nodes": [
                {
                    "name": "Imported block",
                    "parent_id": page["id"],
                    "sequence": 0,
                    "uuid": custom_uuid,
                },
            ]
        }
        resp = await authenticated_client.post("/api/nodes/batch", json=batch_payload)
        assert resp.status_code == 200
        data = resp.json()
        assert data["created"] == 1
        assert data["results"][0]["node"]["uuid"] == custom_uuid

    @pytest.mark.asyncio
    async def test_batch_create_partial_failure(
        self,
        authenticated_client: AsyncClient,
        sample_node_data: dict,
    ):
        """One node fails validation but others still succeed."""
        page_resp = await authenticated_client.post("/api/nodes/", json=sample_node_data)
        page = page_resp.json()

        batch_payload = {
            "nodes": [
                {"name": "Good block", "parent_id": page["id"], "sequence": 0},
                # Parent that doesn't exist should cause a failure
                {"name": "Bad block", "parent_id": 999999, "sequence": 0},
                {"name": "Another good block", "parent_id": page["id"], "sequence": 1},
            ]
        }
        resp = await authenticated_client.post("/api/nodes/batch", json=batch_payload)
        assert resp.status_code == 200
        data = resp.json()

        # First and third should succeed, second should fail
        assert data["results"][0]["success"] is True
        assert data["results"][2]["success"] is True
        assert data["created"] >= 2


class TestBatchUpdate:
    """Test batch node update."""

    @pytest.mark.asyncio
    async def test_batch_update_by_id(
        self,
        authenticated_client: AsyncClient,
        sample_node_data: dict,
    ):
        """Batch update nodes identified by id."""
        # Create a page and some blocks
        page_resp = await authenticated_client.post("/api/nodes/", json=sample_node_data)
        page = page_resp.json()

        block_ids = []
        for i in range(3):
            br = await authenticated_client.post(
                "/api/nodes/",
                json={"name": f"Block {i}", "parent_id": page["id"], "sequence": i},
            )
            block_ids.append(br.json()["id"])

        # Batch update all blocks
        batch_payload = {
            "nodes": [
                {"id": block_ids[0], "name": "Updated Block 0"},
                {"id": block_ids[1], "name": "Updated Block 1"},
                {"id": block_ids[2], "name": "Updated Block 2"},
            ]
        }
        resp = await authenticated_client.put("/api/nodes/batch", json=batch_payload)
        assert resp.status_code == 200

        data = resp.json()
        assert data["updated"] == 3
        assert data["failed"] == 0
        for result in data["results"]:
            assert result["success"] is True
            assert "Updated Block" in result["node"]["name"]

    @pytest.mark.asyncio
    async def test_batch_update_by_uuid(
        self,
        authenticated_client: AsyncClient,
        sample_node_data: dict,
    ):
        """Batch update nodes identified by uuid."""
        page_resp = await authenticated_client.post("/api/nodes/", json=sample_node_data)
        page = page_resp.json()

        # Create a block and get its UUID
        br = await authenticated_client.post(
            "/api/nodes/",
            json={"name": "Original", "parent_id": page["id"], "sequence": 0},
        )
        block = br.json()

        batch_payload = {
            "nodes": [
                {"uuid": block["uuid"], "name": "Updated via UUID"},
            ]
        }
        resp = await authenticated_client.put("/api/nodes/batch", json=batch_payload)
        assert resp.status_code == 200

        data = resp.json()
        assert data["updated"] == 1
        assert "Updated via UUID" in data["results"][0]["node"]["name"]

    @pytest.mark.asyncio
    async def test_batch_update_missing_uuid(
        self,
        authenticated_client: AsyncClient,
    ):
        """Update with unknown uuid should fail gracefully."""
        batch_payload = {
            "nodes": [
                {"uuid": "00000000-0000-0000-0000-000000000000", "name": "Nope"},
            ]
        }
        resp = await authenticated_client.put("/api/nodes/batch", json=batch_payload)
        assert resp.status_code == 200

        data = resp.json()
        assert data["updated"] == 0
        assert data["failed"] == 1
        assert "not found" in data["results"][0]["error"]

    @pytest.mark.asyncio
    async def test_batch_update_no_id_or_uuid(
        self,
        authenticated_client: AsyncClient,
    ):
        """Update without id or uuid should fail with a clear error."""
        batch_payload = {
            "nodes": [
                {"name": "No identifier"},
            ]
        }
        resp = await authenticated_client.put("/api/nodes/batch", json=batch_payload)
        assert resp.status_code == 200

        data = resp.json()
        assert data["updated"] == 0
        assert data["failed"] == 1
        assert "id" in data["results"][0]["error"].lower() or "uuid" in data["results"][0]["error"].lower()

    @pytest.mark.asyncio
    async def test_batch_update_empty_list(
        self,
        authenticated_client: AsyncClient,
    ):
        """Empty batch update should succeed with zero counts."""
        resp = await authenticated_client.put("/api/nodes/batch", json={"nodes": []})
        assert resp.status_code == 200
        data = resp.json()
        assert data["updated"] == 0
        assert data["failed"] == 0
