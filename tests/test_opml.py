"""Integration tests for OPML import and export."""

import pytest
from httpx import AsyncClient


class TestOpml:
    """Test OPML outline import and export."""

    @pytest.mark.asyncio
    async def test_import_opml_creates_tree(self, auth_client: AsyncClient):
        """Importing OPML creates nested page nodes."""
        opml = """<?xml version="1.0" encoding="UTF-8"?>
<opml version="2.0">
  <head><title>Import Outline</title></head>
  <body>
    <outline text="Parent">
      <outline text="Child 1"/>
      <outline text="Child 2">
        <outline text="Grandchild"/>
      </outline>
    </outline>
  </body>
</opml>
"""
        import_resp = await auth_client.post(
            "/api/import/opml",
            json={"content": opml},
        )
        assert import_resp.status_code == 200, import_resp.text
        results = import_resp.json()
        assert len(results) == 1
        assert results[0]["title"] == "Parent"

        node_resp = await auth_client.get(
            f"/api/nodes/{results[0]['node_uuid']}",
            params={"include_children": "true"},
        )
        assert node_resp.status_code == 200
        node = node_resp.json()
        assert len(node["children"]) == 2
        assert node["children"][0]["display_name"] == "Child 1"
        assert node["children"][1]["display_name"] == "Child 2"
        assert len(node["children"][1]["children"]) == 1
        assert node["children"][1]["children"][0]["display_name"] == "Grandchild"

    @pytest.mark.asyncio
    async def test_export_opml_round_trip(self, auth_client: AsyncClient):
        """Exporting a page tree to OPML and re-importing it recreates the tree."""
        page_resp = await auth_client.post("/api/nodes/page", params={"name": "OPML Root"})
        assert page_resp.status_code == 200
        root_uuid = page_resp.json()["uuid"]

        await auth_client.post(
            "/api/nodes/",
            json={"name": "Block A", "parent_uuid": root_uuid},
        )
        child_resp = await auth_client.post(
            "/api/nodes/",
            json={"name": "Block B", "parent_uuid": root_uuid},
        )
        child_uuid = child_resp.json()["uuid"]
        await auth_client.post(
            "/api/nodes/",
            json={"name": "Block C", "parent_uuid": child_uuid},
        )

        export_resp = await auth_client.get(f"/api/export/opml/{root_uuid}")
        assert export_resp.status_code == 200
        opml = export_resp.text
        assert "OPML Root" in opml
        assert "Block A" in opml
        assert "Block B" in opml
        assert "Block C" in opml

        import_resp = await auth_client.post(
            "/api/import/opml",
            json={"content": opml},
        )
        assert import_resp.status_code == 200, import_resp.text
        results = import_resp.json()
        assert len(results) == 1
        imported_uuid = results[0]["node_uuid"]

        node_resp = await auth_client.get(
            f"/api/nodes/{imported_uuid}",
            params={"include_children": "true"},
        )
        assert node_resp.status_code == 200
        node = node_resp.json()
        assert node["display_name"] == "OPML Root"
        assert len(node["children"]) == 2
        assert node["children"][0]["display_name"] == "Block A"
        assert node["children"][1]["display_name"] == "Block B"
        assert len(node["children"][1]["children"]) == 1
        assert node["children"][1]["children"][0]["display_name"] == "Block C"
