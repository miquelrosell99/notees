"""Tests for the unlinked mentions index and promote/ignore actions."""

import pytest
from httpx import AsyncClient

pytestmark = pytest.mark.integration


class TestUnlinkedMentions:
    """Test unlinked mention detection, promotion, and ignoring."""

    @pytest.mark.asyncio
    async def test_mention_created_when_page_name_appears_in_content(
        self,
        authenticated_client: AsyncClient,
        test_user: dict,
    ):
        """A block containing a page name should produce an unlinked mention."""
        page_class_id = test_user["page_class_id"]

        target = await authenticated_client.post(
            "/api/nodes/",
            json={"name": "TargetPage", "classes": [page_class_id]},
        )
        assert target.status_code == 200
        target_data = target.json()
        target_uuid = target_data["uuid"]

        source = await authenticated_client.post(
            "/api/nodes/",
            json={"name": "SourcePage", "classes": [page_class_id]},
        )
        assert source.status_code == 200
        source_data = source.json()
        source_uuid = source_data["uuid"]

        block = await authenticated_client.post(
            "/api/nodes/",
            json={
                "name": "I read TargetPage today",
                "parent_uuid": source_uuid,
                "classes": [],
            },
        )
        assert block.status_code == 200
        block_id = block.json()["id"]

        mentions_resp = await authenticated_client.get(f"/api/nodes/{target_uuid}/mentions")
        assert mentions_resp.status_code == 200
        mentions = mentions_resp.json()["mentions"]
        assert len(mentions) == 1
        assert mentions[0]["source_node_id"] == block_id
        assert mentions[0]["match_text"] == "TargetPage"

    @pytest.mark.asyncio
    async def test_promote_mention_creates_link(
        self,
        authenticated_client: AsyncClient,
        test_user: dict,
    ):
        """Promoting a mention should turn it into a real node link."""
        page_class_id = test_user["page_class_id"]

        target = await authenticated_client.post(
            "/api/nodes/",
            json={"name": "TargetPage", "classes": [page_class_id]},
        )
        target_uuid = target.json()["uuid"]

        source = await authenticated_client.post(
            "/api/nodes/",
            json={"name": "SourcePage", "classes": [page_class_id]},
        )
        source_uuid = source.json()["uuid"]

        block = await authenticated_client.post(
            "/api/nodes/",
            json={
                "name": "I read TargetPage today",
                "parent_uuid": source_uuid,
                "classes": [],
            },
        )
        block_id = block.json()["id"]

        mentions_resp = await authenticated_client.get(f"/api/nodes/{target_uuid}/mentions")
        mention_uuid = mentions_resp.json()["mentions"][0]["uuid"]

        promote_resp = await authenticated_client.post(
            f"/api/nodes/{target_uuid}/mentions/{mention_uuid}/promote"
        )
        assert promote_resp.status_code == 200
        assert promote_resp.json()["success"] is True

        # Mention should be gone after promotion.
        mentions_resp = await authenticated_client.get(f"/api/nodes/{target_uuid}/mentions")
        assert mentions_resp.json()["mentions"] == []

        # The target should now have a text backlink.
        backlinks_resp = await authenticated_client.get(f"/api/nodes/{target_uuid}/backlinks")
        backlinks = backlinks_resp.json()["backlinks"]
        assert any(b["source_node_id"] == block_id for b in backlinks)

    @pytest.mark.asyncio
    async def test_ignore_mention_hides_it(
        self,
        authenticated_client: AsyncClient,
        test_user: dict,
    ):
        """Ignoring a mention should remove it from the unlinked list."""
        page_class_id = test_user["page_class_id"]

        target = await authenticated_client.post(
            "/api/nodes/",
            json={"name": "TargetPage", "classes": [page_class_id]},
        )
        target_uuid = target.json()["uuid"]

        source = await authenticated_client.post(
            "/api/nodes/",
            json={"name": "SourcePage", "classes": [page_class_id]},
        )
        source_uuid = source.json()["uuid"]

        await authenticated_client.post(
            "/api/nodes/",
            json={
                "name": "I read TargetPage today",
                "parent_uuid": source_uuid,
                "classes": [],
            },
        )

        mentions_resp = await authenticated_client.get(f"/api/nodes/{target_uuid}/mentions")
        mention_uuid = mentions_resp.json()["mentions"][0]["uuid"]

        ignore_resp = await authenticated_client.post(
            f"/api/nodes/{target_uuid}/mentions/{mention_uuid}/ignore"
        )
        assert ignore_resp.status_code == 200

        mentions_resp = await authenticated_client.get(f"/api/nodes/{target_uuid}/mentions")
        assert mentions_resp.json()["mentions"] == []
