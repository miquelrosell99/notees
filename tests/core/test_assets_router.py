"""Integration tests for the assets router ported to WorkspaceStore."""

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
from app.features.assets.dependencies import get_asset_service, get_asset_service_with_token
from app.features.assets.router import router as assets_router
from app.features.assets.service import AssetService
from app.models import User
from app.relay.storage import SqliteRelayStorage

pytestmark = pytest.mark.unit


class FixedKeyStorage:
    """In-memory key storage that returns a fixed 32-byte master key."""

    async def get_or_create_master_key(self, workspace_id: str, secret_key: str) -> bytes:
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
async def assets_client(tmp_path: Path) -> AsyncGenerator[AsyncClient, None]:
    """Authenticated test client with the assets store dependency overridden."""
    store = await _make_test_store()
    assets_dir = tmp_path / "assets"
    asset_service = AssetService(
        workspace_uuid="ws-uuid-1",
        user_id="user-uuid-1",
        store=store,
        assets_dir=assets_dir,
    )

    async def _override_get_asset_service() -> AsyncGenerator[AssetService, None]:
        yield asset_service

    async def _override_get_asset_service_with_token() -> AsyncGenerator[AssetService, None]:
        yield asset_service

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
    test_app.include_router(assets_router)
    test_app.dependency_overrides[get_asset_service] = _override_get_asset_service
    test_app.dependency_overrides[get_asset_service_with_token] = _override_get_asset_service_with_token
    test_app.dependency_overrides[get_current_user] = _override_get_current_user
    test_app.dependency_overrides[require_read_or_write_scope] = _override_require_scope
    test_app.dependency_overrides[require_write_scope] = _override_require_scope

    transport = ASGITransport(app=test_app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        client._assets_test_service = asset_service  # type: ignore[attr-defined]
        yield client

    await store.close()


def _service(client: AsyncClient) -> AssetService:
    """Return the test AssetService attached to the client."""
    return client._assets_test_service  # type: ignore[no-any-return,attr-defined]


class TestAssetUpload:
    async def test_upload_asset_creates_node_and_file(self, assets_client: AsyncClient) -> None:
        content = b"\xff\xd8\xfffake-jpeg-content"
        response = await assets_client.post(
            "/assets/upload",
            files={"file": ("test.jpg", content, "image/jpeg")},
        )
        assert response.status_code == 200
        body = response.json()
        assert body["filename"] == "test.jpg"
        assert body["content_type"] == "image/jpeg"
        assert body["category"] == "image"
        assert body["size_bytes"] == len(content)
        assert body["uuid"] == body["node_uuid"]

        store = _service(assets_client)._store
        rows = await store.query("SELECT * FROM node_asset WHERE node_id = ?", (body["uuid"],))
        assert len(rows) == 1
        assert rows[0]["original_name"] == "test.jpg"

    async def test_upload_rejects_unsupported_content_type(self, assets_client: AsyncClient) -> None:
        response = await assets_client.post(
            "/assets/upload",
            files={"file": ("test.txt", b"text content", "text/plain")},
        )
        assert response.status_code == 400

    async def test_upload_rejects_bad_magic_bytes(self, assets_client: AsyncClient) -> None:
        response = await assets_client.post(
            "/assets/upload",
            files={"file": ("fake.jpg", b"not-a-jpeg", "image/jpeg")},
        )
        assert response.status_code == 400


class TestAssetDownload:
    async def test_download_asset(self, assets_client: AsyncClient) -> None:
        content = b"\xff\xd8\xfffake-jpeg-content"
        upload_response = await assets_client.post(
            "/assets/upload",
            files={"file": ("test.jpg", content, "image/jpeg")},
        )
        assert upload_response.status_code == 200
        asset_uuid = upload_response.json()["uuid"]

        response = await assets_client.get(f"/assets/{asset_uuid}")
        assert response.status_code == 200
        assert response.content == content

    async def test_download_missing_asset_returns_404(self, assets_client: AsyncClient) -> None:
        response = await assets_client.get("/assets/00000000-0000-0000-0001-000000000099")
        assert response.status_code == 404


class TestAssetInfo:
    async def test_get_asset_info(self, assets_client: AsyncClient) -> None:
        content = b"\xff\xd8\xfffake-jpeg-content"
        upload_response = await assets_client.post(
            "/assets/upload",
            files={"file": ("test.jpg", content, "image/jpeg")},
        )
        asset_uuid = upload_response.json()["uuid"]

        response = await assets_client.get(f"/assets/{asset_uuid}/info")
        assert response.status_code == 200
        body = response.json()
        assert body["uuid"] == asset_uuid
        assert body["filename"] == "test.jpg"
        assert body["size_bytes"] == len(content)


class TestAssetList:
    async def test_list_assets(self, assets_client: AsyncClient) -> None:
        content = b"\xff\xd8\xfffake-jpeg-content"
        upload_response = await assets_client.post(
            "/assets/upload",
            files={"file": ("test.jpg", content, "image/jpeg")},
        )
        asset_uuid = upload_response.json()["uuid"]

        response = await assets_client.get("/assets/")
        assert response.status_code == 200
        body = response.json()
        assert body["total"] == 1
        assert len(body["assets"]) == 1
        assert body["assets"][0]["uuid"] == asset_uuid


class TestAssetDelete:
    async def test_delete_asset(self, assets_client: AsyncClient) -> None:
        content = b"\xff\xd8\xfffake-jpeg-content"
        upload_response = await assets_client.post(
            "/assets/upload",
            files={"file": ("test.jpg", content, "image/jpeg")},
        )
        asset_uuid = upload_response.json()["uuid"]

        response = await assets_client.delete(f"/assets/{asset_uuid}")
        assert response.status_code == 200
        assert response.json()["status"] == "deleted"

        # Derived node_asset row should be gone.
        store = _service(assets_client)._store
        rows = await store.query("SELECT * FROM node_asset WHERE node_id = ?", (asset_uuid,))
        assert len(rows) == 0

    async def test_delete_missing_asset_returns_404(self, assets_client: AsyncClient) -> None:
        response = await assets_client.delete("/assets/00000000-0000-0000-0001-000000000099")
        assert response.status_code == 404
