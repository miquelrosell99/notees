"""Tests for batch node create and update operations.

These tests verify the /api/nodes/batch endpoints for bulk
node creation and updating — useful for Logseq / EDN imports.
"""
import pytest
from httpx import AsyncClient

pytestmark = pytest.mark.integration


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


class TestBatchGetByUuid:
    """Test batch node fetch by UUID."""

    @pytest.mark.asyncio
    async def test_batch_get_by_uuid_multiple_nodes(
        self,
        authenticated_client: AsyncClient,
        sample_node_data: dict,
    ):
        """Fetch several nodes by UUID in a single call."""
        # Create a parent page and two blocks
        page_resp = await authenticated_client.post("/api/nodes/", json=sample_node_data)
        page = page_resp.json()

        blocks = []
        for i in range(2):
            br = await authenticated_client.post(
                "/api/nodes/",
                json={"name": f"Block {i}", "parent_id": page["id"], "sequence": i},
            )
            blocks.append(br.json())

        uuids = [blocks[0]["uuid"], blocks[1]["uuid"]]
        resp = await authenticated_client.post("/api/nodes/batch-get-by-uuid", json={"uuids": uuids})
        assert resp.status_code == 200

        data = resp.json()
        assert set(data["nodes"].keys()) == set(uuids)
        for block in blocks:
            assert data["nodes"][block["uuid"]]["uuid"] == block["uuid"]
            assert data["nodes"][block["uuid"]]["id"] == block["id"]

    @pytest.mark.asyncio
    async def test_batch_get_by_uuid_missing_ignored(
        self,
        authenticated_client: AsyncClient,
        sample_node_data: dict,
    ):
        """Unknown UUIDs are silently omitted from the result."""
        page_resp = await authenticated_client.post("/api/nodes/", json=sample_node_data)
        page = page_resp.json()

        resp = await authenticated_client.post(
            "/api/nodes/batch-get-by-uuid",
            json={"uuids": [page["uuid"], "00000000-0000-0000-0000-000000000000"]},
        )
        assert resp.status_code == 200

        data = resp.json()
        assert list(data["nodes"].keys()) == [page["uuid"]]

    @pytest.mark.asyncio
    async def test_batch_get_by_uuid_empty_list(
        self,
        authenticated_client: AsyncClient,
    ):
        """Empty UUID list returns an empty nodes map."""
        resp = await authenticated_client.post("/api/nodes/batch-get-by-uuid", json={"uuids": []})
        assert resp.status_code == 200
        data = resp.json()
        assert data["nodes"] == {}

    @pytest.mark.asyncio
    async def test_batch_get_by_uuid_resolves_link_display_names(
        self,
        authenticated_client: AsyncClient,
        sample_node_data: dict,
    ):
        """Batch-get resolves inline node links in display_name."""
        import secrets

        # Create a target page and a block whose name is a link to it.
        target_resp = await authenticated_client.post("/api/nodes/", json={"name": "Target Page"})
        assert target_resp.status_code == 200
        target = target_resp.json()

        page_resp = await authenticated_client.post("/api/nodes/", json=sample_node_data)
        assert page_resp.status_code == 200
        page = page_resp.json()

        link_uuid = secrets.token_hex(16)
        link_ast = (
            '[{"type":"paragraph","children":['
            f'{{"type":"node_link","link_id":"{target["uuid"]}:{link_uuid}","ref_type":"node"}}'
            ']}]'
        )
        block_resp = await authenticated_client.post(
            "/api/nodes/",
            json={"name": link_ast, "parent_id": page["id"]},
        )
        assert block_resp.status_code == 200
        block = block_resp.json()

        resp = await authenticated_client.post(
            "/api/nodes/batch-get-by-uuid",
            json={"uuids": [block["uuid"]]},
        )
        assert resp.status_code == 200

        data = resp.json()
        assert data["nodes"][block["uuid"]]["name"] == link_ast
        assert data["nodes"][block["uuid"]]["display_name"] == "Target Page"

    @pytest.mark.asyncio
    async def test_batch_get_by_uuid_resolves_deep_acyclic_link_chain(
        self,
        authenticated_client: AsyncClient,
        sample_node_data: dict,
    ):
        """Deep acyclic link chains resolve beyond the old 5-level cap."""
        import secrets

        # Build a chain: block -> n1 -> n2 -> n3 -> n4 -> n5 -> n6 -> leaf
        pages = []
        for i in range(7):
            resp = await authenticated_client.post("/api/nodes/", json={"name": f"Node {i}"})
            assert resp.status_code == 200
            pages.append(resp.json())

        leaf = pages[-1]
        leaf_update = await authenticated_client.put(
            f"/api/nodes/{leaf['id']}", json={"name": "Leaf Page"}
        )
        assert leaf_update.status_code == 200

        for i in range(len(pages) - 2, -1, -1):
            target = pages[i + 1]
            link_uuid = secrets.token_hex(16)
            name = (
                '[{"type":"paragraph","children":['
                f'{{"type":"node_link","link_id":"{target["uuid"]}:{link_uuid}","ref_type":"node"}}'
                ']}]'
            )
            update = await authenticated_client.put(
                f"/api/nodes/{pages[i]['id']}", json={"name": name}
            )
            assert update.status_code == 200

        page_resp = await authenticated_client.post("/api/nodes/", json=sample_node_data)
        assert page_resp.status_code == 200
        page = page_resp.json()

        link_uuid = secrets.token_hex(16)
        block_name = (
            '[{"type":"paragraph","children":['
            f'{{"type":"node_link","link_id":"{pages[0]["uuid"]}:{link_uuid}","ref_type":"node"}}'
            ']}]'
        )
        block_resp = await authenticated_client.post(
            "/api/nodes/",
            json={"name": block_name, "parent_id": page["id"]},
        )
        assert block_resp.status_code == 200
        block = block_resp.json()

        resp = await authenticated_client.post(
            "/api/nodes/batch-get-by-uuid",
            json={"uuids": [block["uuid"]]},
        )
        assert resp.status_code == 200

        data = resp.json()
        assert data["nodes"][block["uuid"]]["display_name"] == "Leaf Page"

    @pytest.mark.asyncio
    async def test_batch_get_by_uuid_resolves_cyclic_link_without_hanging(
        self,
        authenticated_client: AsyncClient,
        sample_node_data: dict,
    ):
        """Cyclic inline node links terminate instead of looping forever."""
        import secrets

        page_a_resp = await authenticated_client.post("/api/nodes/", json={"name": "Page A"})
        assert page_a_resp.status_code == 200
        page_a = page_a_resp.json()

        page_b_resp = await authenticated_client.post("/api/nodes/", json={"name": "Page B"})
        assert page_b_resp.status_code == 200
        page_b = page_b_resp.json()

        page_resp = await authenticated_client.post("/api/nodes/", json=sample_node_data)
        assert page_resp.status_code == 200
        page = page_resp.json()

        # A's name links to B; B's name links to A.
        link_a = secrets.token_hex(16)
        link_b = secrets.token_hex(16)
        name_a = (
            '[{"type":"paragraph","children":['
            f'{{"type":"node_link","link_id":"{page_b["uuid"]}:{link_a}","ref_type":"node"}}'
            ']}]'
        )
        name_b = (
            '[{"type":"paragraph","children":['
            f'{{"type":"node_link","link_id":"{page_a["uuid"]}:{link_b}","ref_type":"node"}}'
            ']}]'
        )
        update_a = await authenticated_client.put(
            f"/api/nodes/{page_a['id']}", json={"name": name_a}
        )
        assert update_a.status_code == 200
        update_b = await authenticated_client.put(
            f"/api/nodes/{page_b['id']}", json={"name": name_b}
        )
        assert update_b.status_code == 200

        link_uuid = secrets.token_hex(16)
        block_name = (
            '[{"type":"paragraph","children":['
            f'{{"type":"node_link","link_id":"{page_a["uuid"]}:{link_uuid}","ref_type":"node"}}'
            ']}]'
        )
        block_resp = await authenticated_client.post(
            "/api/nodes/",
            json={"name": block_name, "parent_id": page["id"]},
        )
        assert block_resp.status_code == 200
        block = block_resp.json()

        resp = await authenticated_client.post(
            "/api/nodes/batch-get-by-uuid",
            json={"uuids": [block["uuid"]]},
        )
        assert resp.status_code == 200

        data = resp.json()
        # Pure cyclic chain has no base text, so it collapses to the cycle placeholder.
        assert data["nodes"][block["uuid"]]["display_name"] == "…"

