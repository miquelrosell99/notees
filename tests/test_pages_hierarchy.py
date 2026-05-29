"""Test page hierarchy in list_nodes endpoint."""
import pytest
from httpx import AsyncClient


class TestPagesHierarchy:
    """Test that list_nodes returns child pages in the tree."""

    @pytest.mark.asyncio
    async def test_list_nodes_include_children_returns_child_pages(
        self,
        authenticated_client: AsyncClient,
        test_user: dict,
    ):
        """When include_children=true and root_only=true, child pages should be nested."""
        page_class_id = test_user["page_class_id"]

        # Create a root page
        root_response = await authenticated_client.post(
            "/api/nodes/",
            json={
                "name": "Root Page",
                "classes": [page_class_id],
            },
        )
        assert root_response.status_code == 200
        root = root_response.json()
        root_id = root["id"]

        # Create a child page under the root
        child_response = await authenticated_client.post(
            "/api/nodes/",
            json={
                "name": "Child Page",
                "classes": [page_class_id],
                "parent_id": root_id,
            },
        )
        assert child_response.status_code == 200
        child = child_response.json()
        child_id = child["id"]

        # List pages with include_children and root_only
        list_response = await authenticated_client.get(
            "/api/nodes/",
            params={
                "pages_only": "true",
                "include_children": "true",
                "root_only": "true",
            },
        )
        assert list_response.status_code == 200
        data = list_response.json()

        items = data["items"]
        assert len(items) >= 1

        # Find the root page in the response
        root_item = next((item for item in items if item["id"] == root_id), None)
        assert root_item is not None, f"Root page {root_id} should be in response. Items: {items}"

        # The root page should have children
        children = root_item.get("children", [])
        assert len(children) >= 1, f"Root page should have children, got: {children}"

        # The child page should be in the children
        child_ids = [c["id"] for c in children]
        assert child_id in child_ids, f"Child page {child_id} should be in children: {child_ids}"
