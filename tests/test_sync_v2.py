"""Tests for the v2 vector-clock sync batch endpoint."""

from __future__ import annotations

import uuid

import pytest
from httpx import AsyncClient

from app.db.schema.constants import SYSTEM_CLASS_UUIDS
from app.domain.entities.node import NodeCreateData

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

    @pytest.mark.asyncio
    async def test_set_property_op_advances_vector(
        self, authenticated_client: AsyncClient, sample_node_data: dict
    ):
        """A set_property op resolves UUIDs, applies the value, and advances the vector."""
        page_response = await authenticated_client.post("/api/nodes/", json=sample_node_data)
        assert page_response.status_code == 200
        page = page_response.json()

        prop_response = await authenticated_client.post(
            "/api/properties/",
            json={"name": "SyncStatus", "type": "selection"},
        )
        assert prop_response.status_code == 200
        prop = prop_response.json()

        line_response = await authenticated_client.post(
            f"/api/properties/{prop['uuid']}/selection-lines",
            json={"name": "Done"},
        )
        assert line_response.status_code == 200
        line = line_response.json()

        client_id = str(uuid.uuid4())
        response = await authenticated_client.post(
            "/api/sync/batch",
            json={
                "ops": [
                    {
                        "type": "set_property",
                        "client_id": client_id,
                        "seq": 1,
                        "node_uuid": page["uuid"],
                        "property_uuid": prop["uuid"],
                        "property_value": line["uuid"],
                    }
                ],
                "base_vector": {},
            },
            headers={"X-Notees-Sync-Protocol": "v2"},
        )

        assert response.status_code == 200
        data = response.json()
        assert data["applied"] is True
        assert data["new_vectors"][page["uuid"]][client_id] == 1

        props_response = await authenticated_client.get(f"/api/nodes/{page['uuid']}/properties")
        assert props_response.status_code == 200
        props = props_response.json()["properties"]
        matching = [p for p in props if p["property"]["uuid"] == prop["uuid"]]
        assert len(matching) == 1
        values = matching[0]["values"]
        assert any(v.get("selection_line_uuid") == line["uuid"] for v in values)

    @pytest.mark.asyncio
    async def test_create_block_with_classes_and_tags(
        self, authenticated_client: AsyncClient, node_service
    ):
        """A create op can assign classes and tags to the new block."""
        page = await node_service.create_page("Class/Tag Test")
        class_class_id = await node_service._node_repo.find_node_id_by_uuid(
            SYSTEM_CLASS_UUIDS["class"]
        )
        class_node = await node_service.create_node(
            NodeCreateData(name="My Class", classes=[class_class_id])
        )
        tag_node = await node_service.create_node(NodeCreateData(name="My Tag"))

        block_uuid = str(uuid.uuid4())
        response = await authenticated_client.post(
            "/api/sync/batch",
            json={
                "ops": [
                    {
                        "type": "create",
                        "client_id": "c1",
                        "seq": 1,
                        "node_uuid": block_uuid,
                        "parent_uuid": str(page.uuid),
                        "after_uuid": None,
                        "content_ast": [
                            {
                                "type": "paragraph",
                                "children": [{ "type": "text", "text": "hi" }],
                            }
                        ],
                        "class_uuids": [str(class_node.uuid)],
                        "tag_uuids": [str(tag_node.uuid)],
                    }
                ],
                "base_vector": {},
            },
            headers={"X-Notees-Sync-Protocol": "v2"},
        )

        assert response.status_code == 200
        data = response.json()
        assert data["applied"] is True

        block = await node_service.get_node_by_uuid(block_uuid)
        assert block is not None
        assert class_node.id in (block.class_ids or [])
        assert tag_node.id in (block.tag_ids or [])
