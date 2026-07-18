"""Integration tests for Markdown import with YAML frontmatter."""

import asyncio

import pytest
from httpx import AsyncClient


async def _export_single_node_and_download(
    auth_client: AsyncClient, page_uuid: str, params: dict
) -> str:
    """Start a single-node export job, wait for completion, and return the downloaded text."""
    export_resp = await auth_client.get(f"/api/export/{page_uuid}", params=params)
    assert export_resp.status_code == 200, export_resp.text
    job_uuid = export_resp.json()["job_uuid"]

    status = None
    for _ in range(50):
        status_resp = await auth_client.get(f"/api/export/jobs/{job_uuid}")
        assert status_resp.status_code == 200, status_resp.text
        status = status_resp.json()
        if status["status"] in ("completed", "failed"):
            break
        await asyncio.sleep(0.05)

    assert status is not None
    assert status["status"] == "completed", status.get("error", "unknown error")

    download_resp = await auth_client.get(f"/api/export/jobs/{job_uuid}/download")
    assert download_resp.status_code == 200, download_resp.text
    return download_resp.text


@pytest.mark.skip(reason="Legacy PostgreSQL-backed import integration; superseded by WorkspaceStore unit tests in tests/core/test_import_router.py during Phase 7.")
class TestMarkdownImport:
    """Test importing Markdown documents with YAML frontmatter.

    This integration test exercised the legacy node/property services. It is
    retained for reference but skipped while the import island runs on the
    operation-log core via WorkspaceStore.
    """

    @pytest.mark.asyncio
    async def test_import_markdown_creates_page_with_metadata(self, auth_client: AsyncClient):
        """A Markdown document with frontmatter becomes a page with metadata, tags and properties."""
        # Create a selection property so the frontmatter property can resolve.
        prop_resp = await auth_client.post(
            "/api/properties/",
            json={"name": "ImportStatus", "type": "selection"},
        )
        assert prop_resp.status_code == 200
        prop = prop_resp.json()

        sel_resp = await auth_client.post(
            f"/api/properties/{prop['uuid']}/selection-lines",
            json={"name": "Ready"},
        )
        assert sel_resp.status_code == 200
        sel_line = sel_resp.json()

        # Create a tag page so the frontmatter tag resolves.
        tag_resp = await auth_client.post("/api/nodes/page", params={"name": "Imported Tag"})
        assert tag_resp.status_code == 200
        tag = tag_resp.json()

        markdown = f"""---
title: Import Me
icon: "📝"
color: "#ff0000"
tags:
  - name: Imported Tag
    uuid: {tag['uuid']}
properties:
  ImportStatus: Ready
---
# Heading
Body text
"""

        import_resp = await auth_client.post(
            "/api/import/markdown",
            json={
                "items": [{"content": markdown}],
                "uuid_conflict_mode": "block",
            },
        )
        assert import_resp.status_code == 200, import_resp.text
        results = import_resp.json()
        assert len(results) == 1
        assert results[0]["title"] == "Import Me"
        assert results[0]["created"] is True

        node_resp = await auth_client.get(
            f"/api/nodes/{results[0]['node_uuid']}",
            params={"include_properties": "true", "include_children": "true"},
        )
        assert node_resp.status_code == 200
        node = node_resp.json()
        assert node["icon"] == "📝"
        assert node["color"] == "#ff0000"
        assert tag["uuid"] in node["tags_uuid"]
        assert node["children"]
        assert len(node["children"]) == 1

        props_resp = await auth_client.get(f"/api/nodes/{results[0]['node_uuid']}/properties")
        assert props_resp.status_code == 200
        props = props_resp.json()["properties"]
        status_entries = [p for p in props if p["property"]["uuid"] == prop["uuid"]]
        assert len(status_entries) == 1
        assert status_entries[0]["values"][0]["selection_line_uuid"] == sel_line["uuid"]

    @pytest.mark.asyncio
    async def test_import_markdown_preserves_uuid(self, auth_client: AsyncClient):
        """Re-importing a document with the same UUID returns the existing node."""
        page_resp = await auth_client.post("/api/nodes/page", params={"name": "UUID Round Trip"})
        assert page_resp.status_code == 200
        page = page_resp.json()
        page_uuid = page["uuid"]

        markdown = f"""---
uuid: {page_uuid}
title: UUID Round Trip
---
Some body.
"""

        import_resp = await auth_client.post(
            "/api/import/markdown",
            json={
                "items": [{"content": markdown}],
                "uuid_conflict_mode": "return_existing",
            },
        )
        assert import_resp.status_code == 200, import_resp.text
        results = import_resp.json()
        assert results[0]["node_uuid"] == page_uuid
        assert results[0]["existing"] is True

    @pytest.mark.asyncio
    async def test_import_markdown_uuid_conflict_blocks(self, auth_client: AsyncClient):
        """When a UUID already exists and mode is block, the import fails."""
        page_resp = await auth_client.post("/api/nodes/page", params={"name": "Conflict"})
        assert page_resp.status_code == 200
        page_uuid = page_resp.json()["uuid"]

        markdown = f"""---
uuid: {page_uuid}
title: Conflict
---
"""
        import_resp = await auth_client.post(
            "/api/import/markdown",
            json={
                "items": [{"content": markdown}],
                "uuid_conflict_mode": "block",
            },
        )
        assert import_resp.status_code == 400
        assert "already exists" in import_resp.json()["detail"]

    @pytest.mark.asyncio
    async def test_export_import_round_trip_preserves_metadata(self, auth_client: AsyncClient):
        """Exporting a page to Markdown and re-importing it maps back to the same node."""
        # Create a page with a property.
        prop_resp = await auth_client.post(
            "/api/properties/",
            json={"name": "RoundTripStatus", "type": "selection"},
        )
        assert prop_resp.status_code == 200
        prop = prop_resp.json()

        sel_resp = await auth_client.post(
            f"/api/properties/{prop['uuid']}/selection-lines",
            json={"name": "Done"},
        )
        assert sel_resp.status_code == 200
        sel_line = sel_resp.json()

        page_resp = await auth_client.post("/api/nodes/page", params={"name": "Round Trip Page"})
        assert page_resp.status_code == 200
        page = page_resp.json()
        page_uuid = page["uuid"]

        await auth_client.post(
            f"/api/nodes/{page_uuid}/properties",
            json={"property_uuid": prop["uuid"], "value": sel_line["uuid"]},
        )

        await auth_client.post(
            "/api/nodes/",
            json={"name": "Child block", "parent_uuid": page_uuid},
        )

        exported = await _export_single_node_and_download(
            auth_client,
            page_uuid,
            params={"format": "markdown", "properties": "main"},
        )
        assert "RoundTripStatus: Done" in exported

        import_resp = await auth_client.post(
            "/api/import/markdown",
            json={
                "items": [{"content": exported}],
                "uuid_conflict_mode": "return_existing",
            },
        )
        assert import_resp.status_code == 200, import_resp.text
        results = import_resp.json()
        assert results[0]["node_uuid"] == page_uuid
        assert results[0]["existing"] is True
