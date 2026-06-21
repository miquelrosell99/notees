"""Tests for page/block conversion operations."""
import pytest
from httpx import AsyncClient

from app.domain.entities.constants import SYSTEM_CLASS_UUIDS

pytestmark = pytest.mark.integration


class TestConvertBlockToPage:
    """Test converting a block into a page."""

    @pytest.mark.asyncio
    async def test_convert_block_to_page(
        self,
        authenticated_client: AsyncClient,
        sample_block_data: dict,
    ):
        """A block becomes a root page and keeps its children."""
        page_response = await authenticated_client.post("/api/nodes/page", params={"name": "Parent Page"})
        assert page_response.status_code == 200
        page = page_response.json()

        sample_block_data["parent_id"] = page["id"]
        block_response = await authenticated_client.post("/api/nodes/", json=sample_block_data)
        assert block_response.status_code == 200
        block = block_response.json()
        assert block["is_page"] is False

        convert_response = await authenticated_client.post(
            f"/api/nodes/{block['id']}/convert-to-page",
            json={},
        )
        assert convert_response.status_code == 200
        converted = convert_response.json()
        assert converted["is_page"] is True
        assert converted["parent_id"] is None
        assert converted["page_id"] is None

        # Original page should no longer list the converted node as a child
        content_response = await authenticated_client.get(
            f"/api/nodes/page/{page['id']}/content"
        )
        assert content_response.status_code == 200
        content = content_response.json()
        child_ids = [c["id"] for c in content.get("children", [])]
        assert converted["id"] not in child_ids

    @pytest.mark.asyncio
    async def test_convert_block_to_page_with_rename(
        self,
        authenticated_client: AsyncClient,
        sample_block_data: dict,
    ):
        """Conversion accepts a new name."""
        page_response = await authenticated_client.post("/api/nodes/page", params={"name": "Parent Page"})
        page = page_response.json()

        sample_block_data["parent_id"] = page["id"]
        block_response = await authenticated_client.post("/api/nodes/", json=sample_block_data)
        block = block_response.json()

        convert_response = await authenticated_client.post(
            f"/api/nodes/{block['id']}/convert-to-page",
            json={"name": "Renamed Page"},
        )
        assert convert_response.status_code == 200
        converted = convert_response.json()
        assert "Renamed Page" in converted["name"]
        assert converted["is_page"] is True

    @pytest.mark.asyncio
    async def test_convert_block_with_block_only_class_fails(
        self,
        authenticated_client: AsyncClient,
        sample_block_data: dict,
    ):
        """Block-only classes prevent conversion to a page."""
        page_response = await authenticated_client.post("/api/nodes/page", params={"name": "Parent Page"})
        page = page_response.json()

        # Add a query (block-only) class to the block
        classes_response = await authenticated_client.get("/api/nodes/classes")
        query_class = next(
            (c for c in classes_response.json()["nodes"] if c["uuid"] == SYSTEM_CLASS_UUIDS["query"]),
            None,
        )
        assert query_class is not None

        sample_block_data["parent_id"] = page["id"]
        sample_block_data["classes"] = [query_class["id"]]
        block_response = await authenticated_client.post("/api/nodes/", json=sample_block_data)
        block = block_response.json()

        convert_response = await authenticated_client.post(
            f"/api/nodes/{block['id']}/convert-to-page",
            json={},
        )
        assert convert_response.status_code == 422


class TestConvertPageToBlock:
    """Test converting a page into a block."""

    @pytest.mark.asyncio
    async def test_convert_page_to_block(
        self,
        authenticated_client: AsyncClient,
    ):
        """A page becomes a block under the chosen destination page."""
        source_response = await authenticated_client.post("/api/nodes/page", params={"name": "Source Page"})
        source = source_response.json()
        assert source["is_page"] is True

        dest_response = await authenticated_client.post("/api/nodes/page", params={"name": "Destination Page"})
        dest = dest_response.json()

        convert_response = await authenticated_client.post(
            f"/api/nodes/{source['id']}/convert-to-block",
            json={"parent_id": dest["id"]},
        )
        assert convert_response.status_code == 200
        converted = convert_response.json()
        assert converted["is_page"] is False
        assert converted["parent_id"] == dest["id"]
        assert converted["page_id"] == dest["id"]

    @pytest.mark.asyncio
    async def test_convert_page_to_block_propagates_descendant_page_id(
        self,
        authenticated_client: AsyncClient,
        sample_block_data: dict,
    ):
        """Children of the converted page get the destination page as page_id."""
        source_response = await authenticated_client.post("/api/nodes/page", params={"name": "Source Page"})
        source = source_response.json()

        child_response = await authenticated_client.post("/api/nodes/", json={
            **sample_block_data,
            "parent_id": source["id"],
        })
        child = child_response.json()
        assert child["page_id"] == source["id"]

        dest_response = await authenticated_client.post("/api/nodes/page", params={"name": "Destination Page"})
        dest = dest_response.json()

        convert_response = await authenticated_client.post(
            f"/api/nodes/{source['id']}/convert-to-block",
            json={"parent_id": dest["id"]},
        )
        assert convert_response.status_code == 200

        child_after = await authenticated_client.get(f"/api/nodes/{child['id']}")
        assert child_after.status_code == 200
        child_data = child_after.json()
        assert child_data["page_id"] == dest["id"]

    @pytest.mark.asyncio
    async def test_convert_page_to_block_requires_destination_page(
        self,
        authenticated_client: AsyncClient,
    ):
        """Missing parent_id is rejected."""
        source_response = await authenticated_client.post("/api/nodes/page", params={"name": "Source Page"})
        source = source_response.json()

        convert_response = await authenticated_client.post(
            f"/api/nodes/{source['id']}/convert-to-block",
            json={},
        )
        assert convert_response.status_code == 422

    @pytest.mark.asyncio
    async def test_convert_page_to_block_rejects_circular_reference(
        self,
        authenticated_client: AsyncClient,
        sample_block_data: dict,
    ):
        """A page cannot be converted under its own descendant."""
        source_response = await authenticated_client.post("/api/nodes/page", params={"name": "Source Page"})
        source = source_response.json()

        child_response = await authenticated_client.post("/api/nodes/", json={
            **sample_block_data,
            "parent_id": source["id"],
        })
        child = child_response.json()

        convert_response = await authenticated_client.post(
            f"/api/nodes/{source['id']}/convert-to-block",
            json={"parent_id": child["id"]},
        )
        assert convert_response.status_code == 422

    @pytest.mark.asyncio
    async def test_convert_class_page_to_block_fails(
        self,
        authenticated_client: AsyncClient,
        sample_node_data: dict,
        test_user: dict,
    ):
        """A page that defines a class cannot become a block."""
        classes_response = await authenticated_client.get("/api/nodes/classes")
        class_class = next(
            (c for c in classes_response.json()["nodes"] if c["uuid"] == SYSTEM_CLASS_UUIDS["class"]),
            None,
        )
        assert class_class is not None

        source_response = await authenticated_client.post("/api/nodes/", json={
            **sample_node_data,
            "classes": [test_user["page_class_id"], class_class["id"]],
        })
        source = source_response.json()
        assert source["is_page"] is True

        dest_response = await authenticated_client.post("/api/nodes/page", params={"name": "Destination Page"})
        dest = dest_response.json()

        convert_response = await authenticated_client.post(
            f"/api/nodes/{source['id']}/convert-to-block",
            json={"parent_id": dest["id"]},
        )
        assert convert_response.status_code == 422


class TestConvertBlockToPageService:
    """Service-level conversion tests."""

    @pytest.mark.asyncio
    async def test_convert_block_to_page_updates_descendants(self, node_service):
        """Descendants of the converted block get the new page as page_id."""
        page = await node_service.create_page("Parent Page")
        block = await node_service.create_block("Block", parent_id=page.id)
        child = await node_service.create_block("Child", parent_id=block.id)

        assert child.page_id == page.id

        converted = await node_service.convert_block_to_page(block.id)

        assert converted.is_page is True
        assert converted.parent_id is None

        refreshed_child = await node_service.get_node(child.id)
        assert refreshed_child.page_id == converted.id

    @pytest.mark.asyncio
    async def test_convert_page_to_block_updates_descendants(self, node_service):
        """Descendants of the converted page get the destination page as page_id."""
        source = await node_service.create_page("Source Page")
        child = await node_service.create_block("Child", parent_id=source.id)
        dest = await node_service.create_page("Destination Page")

        assert child.page_id == source.id

        converted = await node_service.convert_page_to_block(source.id, dest.id)

        assert converted.is_page is False
        assert converted.parent_id == dest.id
        assert converted.page_id == dest.id

        refreshed_child = await node_service.get_node(child.id)
        assert refreshed_child.page_id == dest.id
