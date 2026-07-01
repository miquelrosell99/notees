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
    async def test_create_op_is_idempotent_on_retry(
        self, authenticated_client: AsyncClient, sample_node_data: dict
    ):
        """A retried create op with the same UUID must not crash with a unique
        constraint violation; it should be treated as already applied.
        """
        page_response = await authenticated_client.post("/api/nodes/", json=sample_node_data)
        page = page_response.json()

        client_id = str(uuid.uuid4())
        new_block_uuid = str(uuid.uuid4())
        payload = {
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
        }

        first = await authenticated_client.post(
            "/api/sync/batch", json=payload, headers={"X-Notees-Sync-Protocol": "v2"}
        )
        assert first.status_code == 200
        first_vectors = first.json()["new_vectors"]

        # Simulate a retry with the same op but the updated base vector the
        # client would have after acking the first response.
        retry_payload = {
            **payload,
            "base_vector": first_vectors,
        }
        second = await authenticated_client.post(
            "/api/sync/batch", json=retry_payload, headers={"X-Notees-Sync-Protocol": "v2"}
        )
        assert second.status_code == 200
        assert second.json()["applied"] is True

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

    @pytest.mark.asyncio
    async def test_update_node_renames_page_and_auto_exports(
        self, authenticated_client: AsyncClient
    ):
        """An update_node op with properties.name persists the rename and the
        page remains exportable afterwards.
        """
        page_response = await authenticated_client.post(
            "/api/nodes/page", params={"name": "Original Name"}
        )
        assert page_response.status_code == 200
        page = page_response.json()
        assert page["is_page"] is True
        page_uuid = page["uuid"]

        client_id = str(uuid.uuid4())
        response = await authenticated_client.post(
            "/api/sync/batch",
            json={
                "ops": [
                    {
                        "type": "update_node",
                        "client_id": client_id,
                        "seq": 1,
                        "node_uuid": page_uuid,
                        "properties": {"name": "Renamed Page"},
                    }
                ],
                "base_vector": {},
            },
            headers={"X-Notees-Sync-Protocol": "v2"},
        )

        assert response.status_code == 200
        data = response.json()
        assert data["applied"] is True
        assert data["new_vectors"][page_uuid][client_id] == 1

        detail_response = await authenticated_client.get(f"/api/nodes/{page_uuid}")
        assert detail_response.status_code == 200
        assert detail_response.json()["display_name"] == "Renamed Page"

        export_response = await authenticated_client.post(f"/api/auto-export/{page_uuid}")
        assert export_response.status_code == 200
        assert export_response.json()["filename"] == f"{page_uuid}.md"

    @pytest.mark.asyncio
    async def test_update_node_moves_page_and_toggles_private(
        self, authenticated_client: AsyncClient
    ):
        """An update_node op can move a page under a parent and flip is_private."""
        parent_response = await authenticated_client.post(
            "/api/nodes/page", params={"name": "Parent Page"}
        )
        assert parent_response.status_code == 200
        parent_uuid = parent_response.json()["uuid"]

        page_response = await authenticated_client.post(
            "/api/nodes/page", params={"name": "Child Page"}
        )
        assert page_response.status_code == 200
        page_uuid = page_response.json()["uuid"]
        assert page_response.json()["is_private"] is False

        client_id = str(uuid.uuid4())
        response = await authenticated_client.post(
            "/api/sync/batch",
            json={
                "ops": [
                    {
                        "type": "update_node",
                        "client_id": client_id,
                        "seq": 1,
                        "node_uuid": page_uuid,
                        "properties": {
                            "parent_uuid": parent_uuid,
                            "is_private": True,
                        },
                    }
                ],
                "base_vector": {},
            },
            headers={"X-Notees-Sync-Protocol": "v2"},
        )

        assert response.status_code == 200
        data = response.json()
        assert data["applied"] is True

        detail_response = await authenticated_client.get(f"/api/nodes/{page_uuid}")
        assert detail_response.status_code == 200
        detail = detail_response.json()
        assert detail["parent_uuid"] == parent_uuid
        assert detail["is_private"] is True

    @pytest.mark.asyncio
    async def test_update_node_clear_parent(
        self, authenticated_client: AsyncClient
    ):
        """An update_node op with parent_uuid null moves a page to the root."""
        parent_response = await authenticated_client.post(
            "/api/nodes/page", params={"name": "Parent Page"}
        )
        assert parent_response.status_code == 200
        parent_uuid = parent_response.json()["uuid"]

        page_response = await authenticated_client.post(
            "/api/nodes/page", params={"name": "Child Page"}
        )
        assert page_response.status_code == 200
        page_uuid = page_response.json()["uuid"]

        # First move under parent
        client_id = str(uuid.uuid4())
        response = await authenticated_client.post(
            "/api/sync/batch",
            json={
                "ops": [
                    {
                        "type": "update_node",
                        "client_id": client_id,
                        "seq": 1,
                        "node_uuid": page_uuid,
                        "properties": {"parent_uuid": parent_uuid},
                    }
                ],
                "base_vector": {},
            },
            headers={"X-Notees-Sync-Protocol": "v2"},
        )
        assert response.status_code == 200

        # Then clear parent
        response = await authenticated_client.post(
            "/api/sync/batch",
            json={
                "ops": [
                    {
                        "type": "update_node",
                        "client_id": client_id,
                        "seq": 2,
                        "node_uuid": page_uuid,
                        "properties": {"parent_uuid": None},
                    }
                ],
                "base_vector": response.json()["new_vectors"],
            },
            headers={"X-Notees-Sync-Protocol": "v2"},
        )
        assert response.status_code == 200

        detail_response = await authenticated_client.get(f"/api/nodes/{page_uuid}")
        assert detail_response.status_code == 200
        assert detail_response.json()["parent_uuid"] is None

    @pytest.mark.asyncio
    async def test_update_node_converts_block_to_page(
        self, authenticated_client: AsyncClient
    ):
        """An update_node op with is_page=true converts a block into a root page."""
        page_response = await authenticated_client.post(
            "/api/nodes/page", params={"name": "Parent Page"}
        )
        assert page_response.status_code == 200
        parent_uuid = page_response.json()["uuid"]

        block_response = await authenticated_client.post(
            "/api/nodes/",
            json={
                "name": "[{\"type\":\"paragraph\",\"children\":[{\"type\":\"text\",\"text\":\"Block\"}]}]",
                "parent_uuid": parent_uuid,
            },
        )
        assert block_response.status_code == 200
        block_uuid = block_response.json()["uuid"]
        assert block_response.json()["is_page"] is False

        client_id = str(uuid.uuid4())
        response = await authenticated_client.post(
            "/api/sync/batch",
            json={
                "ops": [
                    {
                        "type": "update_node",
                        "client_id": client_id,
                        "seq": 1,
                        "node_uuid": block_uuid,
                        "properties": {"is_page": True, "name": "Promoted Page"},
                    }
                ],
                "base_vector": {},
            },
            headers={"X-Notees-Sync-Protocol": "v2"},
        )
        assert response.status_code == 200
        assert response.json()["applied"] is True

        detail_response = await authenticated_client.get(f"/api/nodes/{block_uuid}")
        assert detail_response.status_code == 200
        detail = detail_response.json()
        assert detail["is_page"] is True
        assert detail["parent_uuid"] is None
        assert detail["display_name"] == "Promoted Page"

    @pytest.mark.asyncio
    async def test_update_node_converts_page_to_block(
        self, authenticated_client: AsyncClient
    ):
        """An update_node op with is_page=false converts a page into a block."""
        parent_response = await authenticated_client.post(
            "/api/nodes/page", params={"name": "Parent Page"}
        )
        assert parent_response.status_code == 200
        parent_uuid = parent_response.json()["uuid"]

        page_response = await authenticated_client.post(
            "/api/nodes/page", params={"name": "Child Page"}
        )
        assert page_response.status_code == 200
        page_uuid = page_response.json()["uuid"]

        client_id = str(uuid.uuid4())
        response = await authenticated_client.post(
            "/api/sync/batch",
            json={
                "ops": [
                    {
                        "type": "update_node",
                        "client_id": client_id,
                        "seq": 1,
                        "node_uuid": page_uuid,
                        "properties": {"is_page": False, "parent_uuid": parent_uuid},
                    }
                ],
                "base_vector": {},
            },
            headers={"X-Notees-Sync-Protocol": "v2"},
        )
        assert response.status_code == 200
        assert response.json()["applied"] is True

        detail_response = await authenticated_client.get(f"/api/nodes/{page_uuid}")
        assert detail_response.status_code == 200
        detail = detail_response.json()
        assert detail["is_page"] is False
        assert detail["parent_uuid"] == parent_uuid
