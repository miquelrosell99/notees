"""Unit tests for the collab Yjs router ported to WorkspaceStore."""

from __future__ import annotations

from collections.abc import AsyncGenerator
from datetime import UTC, datetime
from pathlib import Path

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
from app.features.collab.dependencies import get_workspace_store
from app.features.collab.yjs_router import router as yjs_router
from app.models import User
from app.relay.key_storage import WorkspaceKeyStorage
from app.relay.storage import SqliteRelayStorage

pytestmark = pytest.mark.unit


class FixedKeyStorage(WorkspaceKeyStorage):
    """In-memory key storage that returns a fixed 32-byte master key."""

    async def get_or_create_master_key(
        self, workspace_id: str, secret_key: str
    ) -> bytes:
        return b"0" * 32


async def _make_test_store(
    workspace_id: str = "ws-uuid-1",
    actor_id: str = "actor-1",
    db_path: str = ":memory:",
) -> WorkspaceStore:
    return WorkspaceStore(
        workspace_id=workspace_id,
        actor_id=actor_id,
        relay_storage=SqliteRelayStorage(":memory:"),
        db_path=db_path,
        key_storage=FixedKeyStorage(),
    )


@pytest_asyncio.fixture
async def yjs_client(tmp_path: Path) -> AsyncGenerator[AsyncClient, None]:
    """Authenticated test client with the collab store dependency overridden."""
    store = await _make_test_store(db_path=str(tmp_path / "derived.db"))

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
    test_app.include_router(yjs_router)
    test_app.dependency_overrides[get_workspace_store] = _override_get_workspace_store
    test_app.dependency_overrides[get_current_user] = _override_get_current_user
    test_app.dependency_overrides[require_read_or_write_scope] = _override_require_scope
    test_app.dependency_overrides[require_write_scope] = _override_require_scope

    transport = ASGITransport(app=test_app)  # type: ignore[arg-type]
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        client._collab_test_store = store  # type: ignore[attr-defined]
        yield client


def _store(client: AsyncClient) -> WorkspaceStore:
    """Return the test WorkspaceStore attached to the client."""
    return client._collab_test_store  # type: ignore[no-any-return,attr-defined]


class TestYjsState:
    async def test_get_state_empty_for_new_node(self, yjs_client: AsyncClient) -> None:
        response = await yjs_client.get("/nodes/page-uuid-1/yjs_state")
        assert response.status_code == 200
        assert response.content == b""

    async def test_post_update_persists_to_operation_log(
        self, yjs_client: AsyncClient
    ) -> None:
        store = _store(yjs_client)
        await store.create_node("page-uuid-1", "page")
        await store.sync()

        update = b"\x00\x01\x02fake-yjs-update"
        response = await yjs_client.post(
            "/nodes/page-uuid-1/yjs_update",
            content=update,
        )
        assert response.status_code == 200
        assert response.json()["status"] == "ok"

        # The operation should be applied to derived state.
        rows = await store.query(
            "SELECT text_state FROM crdt_state WHERE node_id = ?",
            ("page-uuid-1",),
        )
        assert len(rows) == 1
        assert rows[0]["text_state"] == update

        # GET should return the stored blob.
        get_response = await yjs_client.get("/nodes/page-uuid-1/yjs_state")
        assert get_response.status_code == 200
        assert get_response.content == update

    async def test_post_update_rejects_missing_node(
        self, yjs_client: AsyncClient
    ) -> None:
        response = await yjs_client.post(
            "/nodes/missing-uuid/yjs_update",
            content=b"\x00\x01",
        )
        assert response.status_code == 404

    async def test_post_update_rejects_oversized_payload(
        self, yjs_client: AsyncClient
    ) -> None:
        store = _store(yjs_client)
        await store.create_node("page-uuid-1", "page")
        await store.sync()

        response = await yjs_client.post(
            "/nodes/page-uuid-1/yjs_update",
            content=b"x" * (2 * 1024 * 1024),
        )
        assert response.status_code == 413

    async def test_post_update_is_idempotent(self, yjs_client: AsyncClient) -> None:
        store = _store(yjs_client)
        await store.create_node("page-uuid-1", "page")
        await store.sync()

        update = b"\xaa\xbb\xcc"
        response1 = await yjs_client.post(
            "/nodes/page-uuid-1/yjs_update", content=update
        )
        response2 = await yjs_client.post(
            "/nodes/page-uuid-1/yjs_update", content=update
        )
        assert response1.status_code == 200
        assert response2.status_code == 200

        rows = await store.query(
            "SELECT text_state FROM crdt_state WHERE node_id = ?",
            ("page-uuid-1",),
        )
        assert len(rows) == 1

    async def test_post_update_sets_node_content_placeholder(
        self, yjs_client: AsyncClient
    ) -> None:
        store = _store(yjs_client)
        await store.create_node("page-uuid-1", "page")
        await store.sync()

        await yjs_client.post("/nodes/page-uuid-1/yjs_update", content=b"\x01\x02")

        rows = await store.query(
            "SELECT content FROM node WHERE id = ?", ("page-uuid-1",)
        )
        assert len(rows) == 1
        import json

        assert json.loads(rows[0]["content"]) == [{"type": "text", "text": ""}]


class TestYjsStateNodeKinds:
    async def test_post_update_accepts_block_nodes(self, yjs_client: AsyncClient) -> None:
        store = _store(yjs_client)
        await store.create_node("block-uuid-1", "block")
        await store.sync()

        response = await yjs_client.post(
            "/nodes/block-uuid-1/yjs_update",
            content=b"\x00\x01",
        )
        assert response.status_code == 200
