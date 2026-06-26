"""Tests for the v2 vector-clock sync batch endpoint."""

from __future__ import annotations

import uuid

import pytest
from httpx import AsyncClient

pytestmark = pytest.mark.integration


class TestSyncBatchV2:
    """Integration tests for POST /api/sync/batch."""

    @pytest.mark.asyncio
    async def test_update_content_advances_vector(
        self, authenticated_client: AsyncClient, sample_node_data: dict
    ):
        """A simple content update succeeds and returns an updated vector."""
        page_response = await authenticated_client.post("/api/nodes/", json=sample_node_data)
        assert page_response.status_code == 200
        page = page_response.json()

        block_response = await authenticated_client.post(
            "/api/nodes/",
            json={
                "name": "block",
                "parent_uuid": page["uuid"],
                "is_page": False,
            },
        )
        assert block_response.status_code == 200
        block = block_response.json()

        client_id = str(uuid.uuid4())
        response = await authenticated_client.post(
            "/api/sync/batch",
            json={
                "ops": [
                    {
                        "type": "update_content",
                        "client_id": client_id,
                        "seq": 1,
                        "node_uuid": block["uuid"],
                        "content_ast": [{"type": "paragraph", "children": []}],
                    }
                ],
                "base_vector": {},
            },
            headers={"X-Notees-Sync-Protocol": "v2"},
        )

        assert response.status_code == 200
        data = response.json()
        assert data["applied"] is True
        assert data["new_vectors"][block["uuid"]][client_id] == 1

    @pytest.mark.asyncio
    async def test_concurrent_edit_returns_409(
        self, authenticated_client: AsyncClient, sample_node_data: dict
    ):
        """Two clients editing the same block concurrently produce a 409 conflict."""
        page_response = await authenticated_client.post("/api/nodes/", json=sample_node_data)
        page = page_response.json()

        block_response = await authenticated_client.post(
            "/api/nodes/",
            json={
                "name": "block",
                "parent_uuid": page["uuid"],
                "is_page": False,
            },
        )
        block = block_response.json()

        client_a = str(uuid.uuid4())
        client_b = str(uuid.uuid4())

        # Client A applies seq 1.
        first = await authenticated_client.post(
            "/api/sync/batch",
            json={
                "ops": [
                    {
                        "type": "update_content",
                        "client_id": client_a,
                        "seq": 1,
                        "node_uuid": block["uuid"],
                        "content_ast": [{"type": "paragraph", "children": []}],
                    }
                ],
                "base_vector": {},
            },
            headers={"X-Notees-Sync-Protocol": "v2"},
        )
        assert first.status_code == 200

        # Client B bases its edit on an empty vector and should conflict.
        second = await authenticated_client.post(
            "/api/sync/batch",
            json={
                "ops": [
                    {
                        "type": "update_content",
                        "client_id": client_b,
                        "seq": 1,
                        "node_uuid": block["uuid"],
                        "content_ast": [{"type": "paragraph", "children": []}],
                    }
                ],
                "base_vector": {},
            },
            headers={"X-Notees-Sync-Protocol": "v2"},
        )

        assert second.status_code == 409
        conflict = second.json()["detail"]
        assert block["uuid"] in conflict["stale_nodes"]
        assert conflict["conflict_type"] == "text_edit"

    @pytest.mark.asyncio
    async def test_create_op_increments_parent_and_child_vectors(
        self, authenticated_client: AsyncClient, sample_node_data: dict
    ):
        """A create op advances vectors for both the new block and its parent."""
        page_response = await authenticated_client.post("/api/nodes/", json=sample_node_data)
        page = page_response.json()

        client_id = str(uuid.uuid4())
        new_block_uuid = str(uuid.uuid4())
        response = await authenticated_client.post(
            "/api/sync/batch",
            json={
                "ops": [
                    {
                        "type": "create",
                        "client_id": client_id,
                        "seq": 1,
                        "node_uuid": new_block_uuid,
                        "parent_uuid": page["uuid"],
                        "content_ast": [{"type": "paragraph", "children": []}],
                    }
                ],
                "base_vector": {},
            },
            headers={"X-Notees-Sync-Protocol": "v2"},
        )

        assert response.status_code == 200
        data = response.json()
        assert data["new_vectors"][page["uuid"]][client_id] == 1
        assert data["new_vectors"][new_block_uuid][client_id] == 1
