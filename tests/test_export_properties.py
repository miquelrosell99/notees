"""Integration tests for export properties behavior.

Verifies that the markdown exporter correctly respects the `properties`
export setting for both YAML frontmatter and inline body properties.
"""
import asyncio

import pytest
from httpx import AsyncClient


async def _export_single_node_and_download(
    auth_client: AsyncClient, page_uuid: str, params: dict
) -> str:
    """Start a single-node export job, wait for completion, and return the downloaded text."""
    export_resp = await auth_client.get(f"/api/export/{page_uuid}", params=params)
    assert export_resp.status_code == 200, export_resp.text
    job_id = export_resp.json()["job_id"]

    status = None
    for _ in range(50):
        status_resp = await auth_client.get(f"/api/export/jobs/{job_id}")
        assert status_resp.status_code == 200, status_resp.text
        status = status_resp.json()
        if status["status"] in ("completed", "failed"):
            break
        await asyncio.sleep(0.05)

    assert status is not None
    assert status["status"] == "completed", status.get("error", "unknown error")

    download_resp = await auth_client.get(f"/api/export/jobs/{job_id}/download")
    assert download_resp.status_code == 200, download_resp.text
    return download_resp.text


class TestMarkdownExportProperties:
    """Test markdown export with different property settings."""

    @pytest.mark.asyncio
    async def test_export_markdown_properties_none_hides_frontmatter_props(
        self, auth_client: AsyncClient
    ):
        """When properties='none', frontmatter must not contain properties."""
        # Create a page
        page_resp = await auth_client.post("/api/nodes/page", params={"name": "Prop Test Page"})
        assert page_resp.status_code == 200
        page = page_resp.json()
        page_id = page["id"]
        page_uuid = page["uuid"]

        # Create a property and assign it to the page
        prop_resp = await auth_client.post(
            "/api/properties/",
            json={"name": "ExportStatusNone", "type": "selection"},
        )
        assert prop_resp.status_code == 200
        prop = prop_resp.json()
        prop_id = prop["id"]

        # Add a selection line
        sel_resp = await auth_client.post(
            f"/api/properties/{prop_id}/selection-lines",
            json={"name": "Ready"},
        )
        assert sel_resp.status_code == 200
        sel_line = sel_resp.json()
        sel_line_id = sel_line["id"]

        # Add a child block so markdown export doesn't fail with "no child nodes"
        block_resp = await auth_client.post(
            "/api/nodes/",
            json={"name": "Empty Block", "parent_id": page_id},
        )
        assert block_resp.status_code == 200

        # Assign property value to the page
        await auth_client.post(
            f"/api/nodes/{page_id}/properties",
            json={"property_id": prop_id, "value": sel_line_id},
        )

        # Export with properties=none
        content = await _export_single_node_and_download(
            auth_client,
            page_uuid,
            params={"format": "markdown", "properties": "none"},
        )

        # Frontmatter should NOT contain properties
        assert "properties:" not in content
        # Body should NOT contain inline properties
        assert "ExportStatus::" not in content

    @pytest.mark.asyncio
    async def test_export_markdown_properties_main_shows_frontmatter_only(
        self, auth_client: AsyncClient
    ):
        """When properties='main', frontmatter has props, body has none for children."""
        # Create a page
        page_resp = await auth_client.post("/api/nodes/page", params={"name": "Prop Test Page 2"})
        assert page_resp.status_code == 200
        page = page_resp.json()
        page_id = page["id"]
        page_uuid = page["uuid"]

        # Create a child block
        block_resp = await auth_client.post(
            "/api/nodes/",
            json={"name": "Child Block", "parent_id": page_id},
        )
        assert block_resp.status_code == 200
        block = block_resp.json()
        block_id = block["id"]

        # Create a property
        prop_resp = await auth_client.post(
            "/api/properties/",
            json={"name": "BlockStatusMain", "type": "selection"},
        )
        assert prop_resp.status_code == 200
        prop = prop_resp.json()
        prop_id = prop["id"]

        # Add selection line
        sel_resp = await auth_client.post(
            f"/api/properties/{prop_id}/selection-lines",
            json={"name": "Done"},
        )
        assert sel_resp.status_code == 200
        sel_line = sel_resp.json()
        sel_line_id = sel_line["id"]

        # Assign property to page and block
        await auth_client.post(
            f"/api/nodes/{page_id}/properties",
            json={"property_id": prop_id, "value": sel_line_id},
        )
        await auth_client.post(
            f"/api/nodes/{block_id}/properties",
            json={"property_id": prop_id, "value": sel_line_id},
        )

        # Export with properties=main
        content = await _export_single_node_and_download(
            auth_client,
            page_uuid,
            params={"format": "markdown", "properties": "main"},
        )

        # Frontmatter SHOULD contain page properties
        assert "properties:" in content
        assert "BlockStatusMain: Done" in content

        # Body should NOT contain inline properties for child blocks
        assert "BlockStatusMain::" not in content

    @pytest.mark.asyncio
    async def test_export_markdown_properties_all_shows_recursive_props(
        self, auth_client: AsyncClient
    ):
        """When properties='all', body shows inline props for all blocks recursively."""
        # Create a page
        page_resp = await auth_client.post("/api/nodes/page", params={"name": "Prop Test Page 3"})
        assert page_resp.status_code == 200
        page = page_resp.json()
        page_id = page["id"]
        page_uuid = page["uuid"]

        # Create nested blocks: page -> block1 -> block2
        block1_resp = await auth_client.post(
            "/api/nodes/",
            json={"name": "Block 1", "parent_id": page_id},
        )
        assert block1_resp.status_code == 200
        block1_id = block1_resp.json()["id"]

        block2_resp = await auth_client.post(
            "/api/nodes/",
            json={"name": "Block 2", "parent_id": block1_id},
        )
        assert block2_resp.status_code == 200
        block2_id = block2_resp.json()["id"]

        # Create a property
        prop_resp = await auth_client.post(
            "/api/properties/",
            json={"name": "TaskStatusAll", "type": "selection"},
        )
        assert prop_resp.status_code == 200
        prop_id = prop_resp.json()["id"]

        # Add selection line
        sel_resp = await auth_client.post(
            f"/api/properties/{prop_id}/selection-lines",
            json={"name": "In Progress"},
        )
        assert sel_resp.status_code == 200
        sel_line_id = sel_resp.json()["id"]

        # Assign to all nodes
        for nid in [page_id, block1_id, block2_id]:
            await auth_client.post(
                f"/api/nodes/{nid}/properties",
                json={"property_id": prop_id, "value": sel_line_id},
            )

        # Export with properties=all
        content = await _export_single_node_and_download(
            auth_client,
            page_uuid,
            params={"format": "markdown", "properties": "all"},
        )

        # Frontmatter should have page properties
        assert "properties:" in content
        assert "TaskStatusAll: In Progress" in content

        # Body should have inline properties for ALL blocks recursively
        assert content.count("TaskStatusAll:: In Progress") == 2

    @pytest.mark.asyncio
    async def test_export_markdown_properties_none_body_no_props(
        self, auth_client: AsyncClient
    ):
        """When properties='none', body must not show any inline properties."""
        # Create a page with a child block that has a property
        page_resp = await auth_client.post("/api/nodes/page", params={"name": "No Props Page"})
        assert page_resp.status_code == 200
        page_id = page_resp.json()["id"]
        page_uuid = page_resp.json()["uuid"]

        block_resp = await auth_client.post(
            "/api/nodes/",
            json={"name": "Block with prop", "parent_id": page_id},
        )
        assert block_resp.status_code == 200
        block_id = block_resp.json()["id"]

        # Create property
        prop_resp = await auth_client.post(
            "/api/properties/",
            json={"name": "PriorityNone", "type": "selection"},
        )
        assert prop_resp.status_code == 200
        prop_id = prop_resp.json()["id"]

        sel_resp = await auth_client.post(
            f"/api/properties/{prop_id}/selection-lines",
            json={"name": "High"},
        )
        assert sel_resp.status_code == 200
        sel_line_id = sel_resp.json()["id"]

        await auth_client.post(
            f"/api/nodes/{block_id}/properties",
            json={"property_id": prop_id, "value": sel_line_id},
        )

        # Export with properties=none
        content = await _export_single_node_and_download(
            auth_client,
            page_uuid,
            params={"format": "markdown", "properties": "none"},
        )

        assert "Priority::" not in content
        assert "properties:" not in content
