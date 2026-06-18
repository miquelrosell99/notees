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
        target_id = target.json()["id"]

        source = await authenticated_client.post(
            "/api/nodes/",
            json={"name": "SourcePage", "classes": [page_class_id]},
        )
        assert source.status_code == 200
        source_id = source.json()["id"]

        block = await authenticated_client.post(
            "/api/nodes/",
            json={
                "name": "I read TargetPage today",
                "parent_id": source_id,
                "classes": [],
            },
        )
        assert block.status_code == 200
        block_id = block.json()["id"]

        mentions_resp = await authenticated_client.get(f"/api/nodes/{target_id}/mentions")
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
        target_id = target.json()["id"]

        source = await authenticated_client.post(
            "/api/nodes/",
            json={"name": "SourcePage", "classes": [page_class_id]},
        )
        source_id = source.json()["id"]

        block = await authenticated_client.post(
            "/api/nodes/",
            json={
                "name": "I read TargetPage today",
                "parent_id": source_id,
                "classes": [],
            },
        )
        block_id = block.json()["id"]

        mentions_resp = await authenticated_client.get(f"/api/nodes/{target_id}/mentions")
        mention_id = mentions_resp.json()["mentions"][0]["id"]

        promote_resp = await authenticated_client.post(
            f"/api/nodes/{target_id}/mentions/{mention_id}/promote"
        )
        assert promote_resp.status_code == 200
        assert promote_resp.json()["success"] is True

        # Mention should be gone after promotion.
        mentions_resp = await authenticated_client.get(f"/api/nodes/{target_id}/mentions")
        assert mentions_resp.json()["mentions"] == []

        # The target should now have a text backlink.
        backlinks_resp = await authenticated_client.get(f"/api/nodes/{target_id}/backlinks")
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
        target_id = target.json()["id"]

        source = await authenticated_client.post(
            "/api/nodes/",
            json={"name": "SourcePage", "classes": [page_class_id]},
        )
        source_id = source.json()["id"]

        await authenticated_client.post(
            "/api/nodes/",
            json={
                "name": "I read TargetPage today",
                "parent_id": source_id,
                "classes": [],
            },
        )

        mentions_resp = await authenticated_client.get(f"/api/nodes/{target_id}/mentions")
        mention_id = mentions_resp.json()["mentions"][0]["id"]

        ignore_resp = await authenticated_client.post(
            f"/api/nodes/{target_id}/mentions/{mention_id}/ignore"
        )
        assert ignore_resp.status_code == 200

        mentions_resp = await authenticated_client.get(f"/api/nodes/{target_id}/mentions")
        assert mentions_resp.json()["mentions"] == []
