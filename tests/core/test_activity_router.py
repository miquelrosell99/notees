"""Integration tests for the activity router ported to WorkspaceStore."""

from __future__ import annotations

from collections.abc import AsyncGenerator
from datetime import UTC, datetime

import pytest
import pytest_asyncio
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient

from app.core.workspace_store import WorkspaceStore
from app.dependencies import (
    get_current_user,
    require_read_or_write_scope,
    require_write_scope,
)
from app.features.activity.dependencies import get_workspace_store
from app.features.activity.router import router as activity_router
from app.models import User
from app.relay.storage import SqliteRelayStorage

pytestmark = pytest.mark.unit


class FixedKeyStorage:
    """In-memory key storage that returns a fixed 32-byte master key."""

    async def get_or_create_master_key(
        self, workspace_id: str, secret_key: str
    ) -> bytes:
        return b"0" * 32


async def _make_test_store(
    workspace_id: str = "ws-uuid-1",
    actor_id: str = "actor-1",
) -> WorkspaceStore:
    return WorkspaceStore(
        workspace_id=workspace_id,
        actor_id=actor_id,
        relay_storage=SqliteRelayStorage(":memory:"),
        db_path=":memory:",
        key_storage=FixedKeyStorage(),
    )


@pytest_asyncio.fixture
async def activity_client() -> AsyncGenerator[AsyncClient, None]:
    """Authenticated test client with the activity store dependency overridden."""
    store = await _make_test_store()

    async def _override_get_workspace_store() -> AsyncGenerator[WorkspaceStore, None]:
        try:
            yield store
        finally:
            await store.close()

    async def _override_get_current_user() -> User:
        return User(
            id="1",
            uuid="user-uuid-1",
            email="test@example.com",
            role="user",
            created_at=datetime.now(UTC),
        )

    async def _override_require_scope() -> User:
        return await _override_get_current_user()

    test_app = FastAPI()
    test_app.include_router(activity_router)
    test_app.dependency_overrides[get_workspace_store] = _override_get_workspace_store
    test_app.dependency_overrides[get_current_user] = _override_get_current_user
    test_app.dependency_overrides[require_read_or_write_scope] = _override_require_scope
    test_app.dependency_overrides[require_write_scope] = _override_require_scope

    transport = ASGITransport(app=test_app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        client._activity_test_store = store  # type: ignore[attr-defined]
        yield client


def _store(client: AsyncClient) -> WorkspaceStore:
    """Return the test WorkspaceStore attached to the client."""
    return client._activity_test_store  # type: ignore[no-any-return,attr-defined]


class TestNodeActivity:
    async def test_get_node_activity_empty(self, activity_client: AsyncClient) -> None:
        response = await activity_client.get("/activity/node/page-uuid-1")
        assert response.status_code == 200
        assert response.json() == []

    async def test_create_and_get_node_activity(self, activity_client: AsyncClient) -> None:
        store = _store(activity_client)
        await store.create_node("page-uuid-1", "page")
        await store.sync()

        create_response = await activity_client.post(
            "/activity/node/page-uuid-1",
            json={
                "action": "property_changed",
                "details": {"property": "status", "old": "todo", "new": "done"},
                "target_node_uuid": "target-uuid-1",
            },
        )
        assert create_response.status_code == 200
        body = create_response.json()
        assert body["node_id"] == "page-uuid-1"
        assert body["action"] == "property_changed"
        assert body["details"] == {"property": "status", "old": "todo", "new": "done"}
        assert body["target_node_uuid"] == "target-uuid-1"

        get_response = await activity_client.get("/activity/node/page-uuid-1")
        assert get_response.status_code == 200
        rows = get_response.json()
        assert len(rows) == 1
        assert rows[0]["action"] == "property_changed"

    async def test_create_activity_rejects_non_page(self, activity_client: AsyncClient) -> None:
        store = _store(activity_client)
        await store.create_node("block-uuid-1", "block")
        await store.sync()

        response = await activity_client.post(
            "/activity/node/block-uuid-1",
            json={"action": "edited"},
        )
        assert response.status_code == 400

    async def test_delete_node_activity(self, activity_client: AsyncClient) -> None:
        store = _store(activity_client)
        await store.create_node("page-uuid-1", "page")
        activity_id = "activity-uuid-1"
        await store.record_activity(activity_id, "page-uuid-1", "edited")
        await store.sync()

        delete_response = await activity_client.delete(
            f"/activity/node/page-uuid-1/{activity_id}"
        )
        assert delete_response.status_code == 200
        assert delete_response.json() == {"success": True}

        # Deletion flows through the operation log so it syncs to other
        # clients and survives derived-state rebuilds.
        envelopes = await store.get_envelopes(0)
        delete_ops = [e for e in envelopes if e.op_type == "activity.delete"]
        assert len(delete_ops) == 1
        assert delete_ops[0].payload["activityId"] == activity_id
        assert delete_ops[0].payload["nodeId"] == "page-uuid-1"

        rows = await store.query(
            "SELECT 1 FROM activity_log WHERE id = ? AND node_id = ?",
            (activity_id, "page-uuid-1"),
        )
        assert len(rows) == 0

    async def test_delete_node_activity_not_found(self, activity_client: AsyncClient) -> None:
        store = _store(activity_client)
        await store.create_node("page-uuid-1", "page")
        await store.sync()

        response = await activity_client.delete("/activity/node/page-uuid-1/missing-activity")
        assert response.status_code == 404

    async def test_get_node_activity_limit_capped(self, activity_client: AsyncClient) -> None:
        response = await activity_client.get("/activity/node/page-uuid-1", params={"limit": 201})
        assert response.status_code == 422

        ok_response = await activity_client.get("/activity/node/page-uuid-1", params={"limit": 200})
        assert ok_response.status_code == 200


class TestLinkClicks:
    async def test_track_link_click(self, activity_client: AsyncClient) -> None:
        store = _store(activity_client)
        await store.create_node("source-uuid-1", "page")
        await store.create_node("target-uuid-1", "page")
        await store.sync()

        response = await activity_client.post(
            "/activity/link/click",
            json={
                "source_node_uuid": "source-uuid-1",
                "target_node_uuid": "target-uuid-1",
            },
        )
        assert response.status_code == 200
        body = response.json()
        assert body["source_node_id"] == "source-uuid-1"
        assert body["target_node_id"] == "target-uuid-1"
        assert body["click_count"] == 1

    async def test_get_link_click(self, activity_client: AsyncClient) -> None:
        store = _store(activity_client)
        await store.create_node("source-uuid-1", "page")
        await store.create_node("target-uuid-1", "page")
        await store.record_link_click("source-uuid-1", "target-uuid-1")
        await store.sync()

        response = await activity_client.get(
            "/activity/link/click/source-uuid-1/target-uuid-1"
        )
        assert response.status_code == 200
        body = response.json()
        assert body["click_count"] == 1
