"""Integration tests for OPML import."""

import pytest
from httpx import AsyncClient


class TestOpml:
    """Test OPML outline import."""

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
