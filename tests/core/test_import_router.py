"""Integration tests for the import router ported to WorkspaceStore."""

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
    require_write_scope,
)
from app.features.import_.dependencies import get_workspace_store
from app.features.import_.router import router as import_router
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
async def import_client() -> AsyncGenerator[AsyncClient, None]:
    """Authenticated test client with the import store dependency overridden."""
    store = await _make_test_store()

    async def _override_get_workspace_store() -> WorkspaceStore:
        return store

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
    test_app.include_router(import_router)
    test_app.dependency_overrides[get_workspace_store] = _override_get_workspace_store
    test_app.dependency_overrides[get_current_user] = _override_get_current_user
    test_app.dependency_overrides[require_write_scope] = _override_require_scope

    transport = ASGITransport(app=test_app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        client._import_test_store = store  # type: ignore[attr-defined]
        yield client

    await store.close()


def _store(client: AsyncClient) -> WorkspaceStore:
    """Return the test WorkspaceStore attached to the client."""
    return client._import_test_store  # type: ignore[no-any-return,attr-defined]


class TestMarkdownImport:
    async def test_import_creates_page(self, import_client: AsyncClient) -> None:
        response = await import_client.post(
            "/import/markdown",
            json={
                "items": [
                    {
                        "content": "# Hello World\n\nThis is the body.",
                        "sequence": 1,
                    }
                ],
                "uuid_conflict_mode": "block",
            },
        )
        assert response.status_code == 200, response.text
        results = response.json()
        assert len(results) == 1
        assert results[0]["title"] == "Hello World"
        assert results[0]["created"] is True
        assert results[0]["existing"] is False

        store = _store(import_client)
        node_rows = await store.query(
            "SELECT kind, content FROM node WHERE id = ?",
            (results[0]["node_uuid"],),
        )
        assert len(node_rows) == 1
        assert node_rows[0]["kind"] == "page"

        child_rows = await store.query(
            "SELECT id, kind, parent_id FROM node WHERE parent_id = ?",
            (results[0]["node_uuid"],),
        )
        assert len(child_rows) == 1
        assert child_rows[0]["kind"] == "block"

    async def test_import_uses_frontmatter_title(self, import_client: AsyncClient) -> None:
        response = await import_client.post(
            "/import/markdown",
            json={
                "items": [
                    {
                        "content": "---\ntitle: Frontmatter Title\n---\n\nBody.",
                    }
                ],
            },
        )
        assert response.status_code == 200, response.text
        results = response.json()
        assert results[0]["title"] == "Frontmatter Title"

    async def test_import_preserves_uuid(self, import_client: AsyncClient) -> None:
        store = _store(import_client)
        existing_uuid = "page-uuid-existing"
        await store.create_node(existing_uuid, "page")
        await store.update_content(existing_uuid, [{"type": "paragraph", "children": [{"type": "text", "text": "Existing"}]}])
        await store.sync()

        response = await import_client.post(
            "/import/markdown",
            json={
                "items": [
                    {
                        "content": f"---\nuuid: {existing_uuid}\ntitle: New Title\n---\n\nBody.",
                    }
                ],
                "uuid_conflict_mode": "return_existing",
            },
        )
        assert response.status_code == 200, response.text
        results = response.json()
        assert results[0]["node_uuid"] == existing_uuid
        assert results[0]["existing"] is True
        assert results[0]["title"] == "Existing"

    async def test_import_uuid_conflict_blocks(self, import_client: AsyncClient) -> None:
        store = _store(import_client)
        existing_uuid = "page-uuid-conflict"
        await store.create_node(existing_uuid, "page")
        await store.sync()

        response = await import_client.post(
            "/import/markdown",
            json={
                "items": [
                    {
                        "content": f"---\nuuid: {existing_uuid}\n---\nBody.",
                    }
                ],
                "uuid_conflict_mode": "block",
            },
        )
        assert response.status_code == 400
        assert "already exists" in response.json()["detail"]

    async def test_import_assigns_classes(self, import_client: AsyncClient) -> None:
        store = _store(import_client)
        class_uuid = "class-uuid-1"
        await store.create_node(class_uuid, "class")
        await store.update_content(
            class_uuid,
            [{"type": "paragraph", "children": [{"type": "text", "text": "MyClass"}]}],
        )
        await store.sync()

        response = await import_client.post(
            "/import/markdown",
            json={
                "items": [
                    {
                        "content": "---\nclasses:\n  - MyClass\n---\n# Title\n",
                    }
                ],
            },
        )
        assert response.status_code == 200, response.text
        node_uuid = response.json()[0]["node_uuid"]

        node_rows = await store.query(
            "SELECT class_ids FROM node WHERE id = ?", (node_uuid,)
        )
        assert len(node_rows) == 1
        assert class_uuid in node_rows[0]["class_ids"]

    async def test_import_sets_properties(self, import_client: AsyncClient) -> None:
        response = await import_client.post(
            "/import/markdown",
            json={
                "items": [
                    {
                        "content": "---\nicon: \"📝\"\ncolor: \"#ff0000\"\nproperties:\n  Status: Done\n---\n# Title\n",
                    }
                ],
            },
        )
        assert response.status_code == 200, response.text
        node_uuid = response.json()[0]["node_uuid"]

        store = _store(import_client)
        prop_rows = await store.query(
            "SELECT property_schema_id, value FROM property_value WHERE node_id = ?",
            (node_uuid,),
        )
        by_name = {row["property_schema_id"]: row["value"] for row in prop_rows}
        import json
        assert '"📝"' in by_name.values() or json.loads(list(by_name.values())[0]) == "📝"
        values = {json.loads(v) for v in by_name.values()}
        assert "📝" in values
        assert "#ff0000" in values
        assert "Done" in values

    async def test_import_resolves_parent(self, import_client: AsyncClient) -> None:
        store = _store(import_client)
        parent_uuid = "parent-uuid-1"
        await store.create_node(parent_uuid, "page")
        await store.sync()

        response = await import_client.post(
            "/import/markdown",
            json={
                "items": [
                    {
                        "content": "# Child\nBody.",
                        "parent_uuid": parent_uuid,
                    }
                ],
            },
        )
        assert response.status_code == 200, response.text
        node_uuid = response.json()[0]["node_uuid"]

        node_rows = await store.query(
            "SELECT parent_id FROM node WHERE id = ?", (node_uuid,)
        )
        assert len(node_rows) == 1
        assert node_rows[0]["parent_id"] == parent_uuid

    async def test_import_rejects_missing_parent(self, import_client: AsyncClient) -> None:
        response = await import_client.post(
            "/import/markdown",
            json={
                "items": [
                    {
                        "content": "# Child\nBody.",
                        "parent_uuid": "missing-parent-uuid",
                    }
                ],
            },
        )
        assert response.status_code == 400
        assert "Parent node not found" in response.json()["detail"]
