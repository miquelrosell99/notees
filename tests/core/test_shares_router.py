"""Integration tests for the shares router ported to WorkspaceStore."""

from __future__ import annotations

from collections.abc import AsyncGenerator, Callable
from datetime import UTC, datetime
from typing import Any
from unittest.mock import AsyncMock

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
from app.domain.entities.share import PublicShare
from app.features.export.service import ExportService
from app.features.shares.dependencies import (
    get_public_workspace_store,
    get_share_repository,
    get_share_repository_for_public,
    get_share_service,
    get_workspace_store,
    get_workspace_store_factory,
)
from app.features.shares.public_router import router as public_router
from app.features.shares.router import (
    node_shares_router,
    workspace_shares_router,
)
from app.features.shares.service import ShareService
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
    relay_storage: SqliteRelayStorage | None = None,
) -> WorkspaceStore:
    return WorkspaceStore(
        workspace_id=workspace_id,
        actor_id=actor_id,
        relay_storage=relay_storage or SqliteRelayStorage(":memory:"),
        db_path=":memory:",
        key_storage=FixedKeyStorage(),
    )


TEST_NODE_UUID = "node-uuid-1"
TEST_TARGET_USER_UUID = "user-uuid-target"


class FakeShareRepository:
    """Minimal in-memory share repository for share router tests."""

    def __init__(self, workspace_id: int = 1, user_id: int | None = 1) -> None:
        self.workspace_id = workspace_id
        self._user_id = user_id
        self._public: dict[str, PublicShare] = {}
        self._user_shares: dict[str, dict[str, Any]] = {}
        self._inbox_entries: list[dict[str, Any]] = []
        self._next_public_id = 1
        self._next_user_id = 1

    def add_inbox_entry(
        self,
        node_uuid: str,
        workspace_id: int = 1,
        workspace_uuid: str = "ws-uuid-1",
        workspace_name: str = "Test Workspace",
        can_write: bool = False,
        shared_by_email: str = "owner@example.com",
        share_uuid: str = "inbox-share-1",
    ) -> None:
        """Seed a share-inbox row for testing."""
        self._inbox_entries.append(
            {
                "share_uuid": share_uuid,
                "node_uuid": node_uuid,
                "can_read": True,
                "can_write": can_write,
                "shared_at": datetime.now(UTC),
                "shared_by_id": 1,
                "shared_by_email": shared_by_email,
                "workspace_id": workspace_id,
                "workspace_name": workspace_name,
                "workspace_uuid": workspace_uuid,
            }
        )

    async def create_share(
        self,
        node_uuid: str,
        workspace_id: int,
        created_by: int,
        expiry_date: str | None = None,
    ) -> PublicShare:
        share = PublicShare(
            id=self._next_public_id,
            uuid=f"public-share-{self._next_public_id}",
            node_uuid=node_uuid,
            workspace_id=workspace_id,
            created_by=created_by,
            created_at=datetime.now(UTC).isoformat(),
            expiry_date=expiry_date,
        )
        self._next_public_id += 1
        self._public[share.uuid] = share
        return share

    async def get_share_by_uuid(self, share_uuid: str) -> PublicShare | None:
        return self._public.get(share_uuid)

    async def list_shares_for_node(self, node_uuid: str) -> list[PublicShare]:
        return [s for s in self._public.values() if s.node_uuid == node_uuid and s.active]

    async def list_shares_for_workspace(self, workspace_id: int) -> list[PublicShare]:
        return [
            s for s in self._public.values() if s.workspace_id == workspace_id and s.active
        ]

    async def delete_share(self, share_uuid: str) -> bool:
        share = self._public.get(share_uuid)
        if share is None:
            return False
        share.active = False
        return True

    async def get_shared_node(self, share_uuid: str) -> dict[str, Any] | None:
        share = await self.get_share_by_uuid(share_uuid)
        if share is None or not share.is_valid():
            return None
        return {"node_uuid": share.node_uuid}

    async def set_share_password(self, share_id: int, password_hash: str) -> None:
        for share in self._public.values():
            if share.id == share_id:
                share.password_hash = password_hash

    async def list_share_inbox(
        self, user_id: int, page: int, page_size: int
    ) -> tuple[int, list[Any]]:
        total = len(self._inbox_entries)
        offset = (page - 1) * page_size
        return total, self._inbox_entries[offset : offset + page_size]

    async def create_node_user_share(
        self,
        node_uuid: str,
        workspace_id: int,
        user_id: int,
        target_email: str,
        permission: str,
    ) -> dict[str, Any] | None:
        if target_email == "unknown@example.com":
            return {
                "status": "pending",
                "email": target_email,
                "invite_token": "invite-token-1",
                "node_uuid": node_uuid,
            }
        row = {
            "id": self._next_user_id,
            "uuid": f"user-share-{self._next_user_id}",
            "node_uuid": node_uuid,
            "user_id": 99,
            "user_uuid": TEST_TARGET_USER_UUID,
            "can_write": permission == "write",
            "create_date": datetime.now(UTC),
            "create_uid": user_id,
            "create_user_uuid": "owner-uuid-1",
            "email": target_email,
        }
        self._next_user_id += 1
        self._user_shares[row["uuid"]] = row
        return row

    async def list_node_user_shares(
        self, node_uuid: str, workspace_id: int, user_id: int
    ) -> list[Any]:
        return [r for r in self._user_shares.values() if r["node_uuid"] == node_uuid]

    async def revoke_user_share(
        self, share_id: int, workspace_id: int, user_id: int
    ) -> dict[str, Any] | None:
        return None

    async def get_node_user_share_by_uuid(
        self, share_uuid: str
    ) -> dict[str, Any] | None:
        return self._user_shares.get(share_uuid)

    async def revoke_user_share_by_uuid(
        self, share_uuid: str, workspace_id: int, user_id: int
    ) -> dict[str, Any] | None:
        row = self._user_shares.get(share_uuid)
        if row is None:
            return None
        del self._user_shares[share_uuid]
        return {
            "node_uuid": row["node_uuid"],
            "share_uuid": share_uuid,
        }


def _make_share_service(share_repo: FakeShareRepository) -> ShareService:
    export_service = AsyncMock(spec=ExportService)
    return ShareService(
        share_repository=share_repo,
        node_export_service=export_service,
        workspace_id=1,
        user_id=1,
        email_sender=None,
        workspace_uuid="ws-uuid-1",
    )


@pytest_asyncio.fixture
async def shares_client() -> AsyncGenerator[AsyncClient, None]:
    """Authenticated test client with the shares store dependency overridden."""
    relay_storage = SqliteRelayStorage(":memory:")
    store = await _make_test_store(actor_id="owner-uuid-1", relay_storage=relay_storage)
    share_repo = FakeShareRepository()
    share_service = _make_share_service(share_repo)

    async def _override_get_workspace_store() -> AsyncGenerator[WorkspaceStore, None]:
        try:
            yield store
        finally:
            await store.close()

    async def _override_get_current_user() -> User:
        return User(
            id="1",
            uuid="owner-uuid-1",
            email="owner@example.com",
            role="user",
            created_at=datetime.now(UTC),
        )

    async def _override_require_scope() -> User:
        return await _override_get_current_user()

    async def _override_get_share_repository() -> AsyncGenerator[Any, None]:
        yield share_repo

    async def _override_get_share_repository_for_public() -> AsyncGenerator[Any, None]:
        yield share_repo

    async def _override_get_share_service() -> AsyncGenerator[Any, None]:
        yield share_service

    async def _override_get_public_workspace_store(
        share_uuid: str,
    ) -> AsyncGenerator[WorkspaceStore, None]:
        try:
            yield store
        finally:
            await store.close()

    async def _override_get_workspace_store_factory() -> Callable[[str], WorkspaceStore]:
        def factory(workspace_uuid: str) -> WorkspaceStore:
            return WorkspaceStore(
                workspace_id=workspace_uuid,
                actor_id="owner-uuid-1",
                relay_storage=relay_storage,
                db_path=":memory:",
                key_storage=FixedKeyStorage(),
            )

        return factory

    test_app = FastAPI()
    test_app.include_router(workspace_shares_router)
    test_app.include_router(node_shares_router)
    test_app.include_router(public_router)
    test_app.dependency_overrides[get_workspace_store] = _override_get_workspace_store
    test_app.dependency_overrides[get_current_user] = _override_get_current_user
    test_app.dependency_overrides[require_read_or_write_scope] = _override_require_scope
    test_app.dependency_overrides[require_write_scope] = _override_require_scope
    test_app.dependency_overrides[get_share_repository] = _override_get_share_repository
    test_app.dependency_overrides[
        get_share_repository_for_public
    ] = _override_get_share_repository_for_public
    test_app.dependency_overrides[get_share_service] = _override_get_share_service
    test_app.dependency_overrides[
        get_public_workspace_store
    ] = _override_get_public_workspace_store
    test_app.dependency_overrides[
        get_workspace_store_factory
    ] = _override_get_workspace_store_factory

    transport = ASGITransport(app=test_app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        client._shares_test_store = store  # type: ignore[attr-defined]
        client._shares_test_repo = share_repo  # type: ignore[attr-defined]
        yield client


def _store(client: AsyncClient) -> WorkspaceStore:
    return client._shares_test_store  # type: ignore[no-any-return,attr-defined]


class TestPublicShares:
    async def test_create_public_share_emits_operation(self, shares_client: AsyncClient) -> None:
        store = _store(shares_client)
        await store.create_node(TEST_NODE_UUID, "page")
        await store.sync()

        response = await shares_client.post(
            f"/{TEST_NODE_UUID}/shares",
            json={"expiry_date": "2026-12-31"},
        )
        assert response.status_code == 200
        body = response.json()
        assert body["share_uuid"].startswith("public-share-")
        assert body["expiry_date"] == "2026-12-31"

        await store.sync()
        rows = await store.query(
            "SELECT * FROM node_public_share WHERE node_id = ?",
            (TEST_NODE_UUID,),
        )
        assert len(rows) == 1
        assert rows[0]["expiry_date"] == "2026-12-31"
        assert rows[0]["workspace_id"] == "ws-uuid-1"

    async def test_list_node_public_shares_reads_derived_table(
        self, shares_client: AsyncClient
    ) -> None:
        store = _store(shares_client)
        await store.create_node(TEST_NODE_UUID, "page")
        await store.create_public_share(
            share_id="share-1", node_uuid=TEST_NODE_UUID, slug="slug-1"
        )
        await store.sync()

        response = await shares_client.get(f"/{TEST_NODE_UUID}/shares")
        assert response.status_code == 200
        body = response.json()
        assert len(body["shares"]) == 1
        assert body["shares"][0]["share_uuid"] == "share-1"

    async def test_delete_public_share_emits_revoke(self, shares_client: AsyncClient) -> None:
        store = _store(shares_client)
        await store.create_node(TEST_NODE_UUID, "page")
        await store.sync()

        create_response = await shares_client.post(
            f"/{TEST_NODE_UUID}/shares",
            json={},
        )
        assert create_response.status_code == 200
        share_uuid = create_response.json()["share_uuid"]

        response = await shares_client.delete(f"/shares/{share_uuid}")
        assert response.status_code == 200

        await store.sync()
        rows = await store.query(
            "SELECT 1 FROM node_public_share WHERE share_id = ?",
            (share_uuid,),
        )
        assert len(rows) == 0


class TestUserShares:
    async def test_create_user_share_emits_grant(self, shares_client: AsyncClient) -> None:
        store = _store(shares_client)
        await store.create_node(TEST_NODE_UUID, "page")
        await store.sync()

        response = await shares_client.post(
            f"/{TEST_NODE_UUID}/user-shares",
            json={"email": "target@example.com", "permission": "write"},
        )
        assert response.status_code == 200
        body = response.json()
        assert body["node_uuid"] == TEST_NODE_UUID
        assert body["shared_with_user_id"] == TEST_TARGET_USER_UUID
        assert body["permission"] == "write"

        await store.sync()
        rows = await store.query(
            "SELECT * FROM node_user_share WHERE node_id = ?",
            (TEST_NODE_UUID,),
        )
        assert len(rows) == 1
        assert rows[0]["target_user_id"] == TEST_TARGET_USER_UUID
        assert rows[0]["permission_bits"] == 7

    async def test_create_user_share_pending_no_operation(self, shares_client: AsyncClient) -> None:
        store = _store(shares_client)
        await store.create_node(TEST_NODE_UUID, "page")
        await store.sync()

        response = await shares_client.post(
            f"/{TEST_NODE_UUID}/user-shares",
            json={"email": "unknown@example.com", "permission": "read"},
        )
        assert response.status_code == 200
        body = response.json()
        assert body["status"] == "pending"

        await store.sync()
        rows = await store.query(
            "SELECT 1 FROM node_user_share WHERE node_id = ?",
            (TEST_NODE_UUID,),
        )
        assert len(rows) == 0

    async def test_list_node_user_shares_reads_derived_table(
        self, shares_client: AsyncClient
    ) -> None:
        store = _store(shares_client)
        await store.create_node(TEST_NODE_UUID, "page")
        await store.grant_user_share(
            share_id="us-1", node_uuid=TEST_NODE_UUID, user_id=TEST_TARGET_USER_UUID, permission="read"
        )
        await store.sync()

        response = await shares_client.get(f"/{TEST_NODE_UUID}/user-shares")
        assert response.status_code == 200
        body = response.json()
        assert len(body) == 1
        assert body[0]["share_uuid"] == "us-1"
        assert body[0]["shared_with_user_id"] == TEST_TARGET_USER_UUID
        assert body[0]["permission"] == "read"

    async def test_revoke_user_share_emits_revoke(self, shares_client: AsyncClient) -> None:
        store = _store(shares_client)
        await store.create_node(TEST_NODE_UUID, "page")
        await store.sync()

        create_response = await shares_client.post(
            f"/{TEST_NODE_UUID}/user-shares",
            json={"email": "target@example.com", "permission": "read"},
        )
        assert create_response.status_code == 200
        share_uuid = create_response.json()["share_uuid"]

        response = await shares_client.delete(f"/user-shares/{share_uuid}")
        assert response.status_code == 200

        await store.sync()
        rows = await store.query(
            "SELECT 1 FROM node_user_share WHERE share_id = ?",
            (share_uuid,),
        )
        assert len(rows) == 0


def _repo(client: AsyncClient) -> FakeShareRepository:
    return client._shares_test_repo  # type: ignore[no-any-return,attr-defined]


class TestShareInbox:
    async def test_share_inbox_enriches_from_derived_store(
        self, shares_client: AsyncClient
    ) -> None:
        store = _store(shares_client)
        repo = _repo(shares_client)
        await store.create_node(TEST_NODE_UUID, "page")
        await store.update_content(
            TEST_NODE_UUID,
            [{"type": "paragraph", "children": [{"type": "text", "text": "Inbox Node"}]}],
        )
        await store.sync()

        repo.add_inbox_entry(
            TEST_NODE_UUID,
            workspace_uuid="ws-uuid-1",
            can_write=True,
        )

        response = await shares_client.get("/shares/inbox")
        assert response.status_code == 200
        body = response.json()
        assert body["total"] == 1
        item = body["items"][0]
        assert item["node_uuid"] == TEST_NODE_UUID
        assert item["node_name"] == "Inbox Node"
        assert item["is_page"] is True
        assert item["node_icon"] is None
        assert item["permission"] == "write"


class TestPublicRouter:
    async def test_public_shared_node_reads_derived_state(self, shares_client: AsyncClient) -> None:
        store = _store(shares_client)
        await store.create_node(TEST_NODE_UUID, "page")
        await store.update_content(
            TEST_NODE_UUID,
            [{"type": "paragraph", "children": [{"type": "text", "text": "Hello"}]}],
        )
        await store.sync()

        create_response = await shares_client.post(
            f"/{TEST_NODE_UUID}/shares",
            json={},
        )
        assert create_response.status_code == 200
        share_uuid = create_response.json()["share_uuid"]

        response = await shares_client.get(f"/public/n/{share_uuid}")
        assert response.status_code == 200
        body = response.json()
        assert body["node"]["uuid"] == TEST_NODE_UUID
        assert body["node"]["display_name"] == "Hello"
        assert "id" not in body["node"]
