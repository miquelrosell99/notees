"""Tests for workspace key management (Phase 5 E3)."""

from __future__ import annotations

import secrets

import pytest

from app.config import settings
from app.core.crypto import (
    derive_user_wrapping_key,
    derive_workspace_key,
    unwrap_key,
)
from app.features.auth import auth
from app.relay.key_management import KeyManagementService, PermissionDeniedError
from app.relay.key_storage import WorkspaceKeyStorage

pytestmark = [pytest.mark.unit, pytest.mark.asyncio]


async def _create_user(email: str, password: str = "testpassword123") -> dict:
    """Create a test user and return the auth module user dict."""
    return await auth.create_user(email, password)


async def _create_workspace_share(
    conn,
    workspace_id: int,
    user_id: int,
    owner_id: int,
    can_read: bool = True,
    can_write: bool = False,
    can_delete: bool = False,
) -> None:
    """Insert an active workspace_share record with the given permissions."""
    await conn.execute(
        """
        INSERT INTO workspace_share (
            workspace_id, user_id, can_read, can_write, can_create, can_delete, can_comment,
            active, create_uid, write_uid
        )
        VALUES ($1, $2, $3, $4, $4, $5, FALSE, TRUE, $6, $6)
        ON CONFLICT (workspace_id, user_id)
        DO UPDATE SET
            can_read = EXCLUDED.can_read,
            can_write = EXCLUDED.can_write,
            can_create = EXCLUDED.can_create,
            can_delete = EXCLUDED.can_delete,
            can_comment = EXCLUDED.can_comment,
            active = TRUE,
            write_uid = EXCLUDED.write_uid,
            write_date = NOW()
        """,
        workspace_id,
        user_id,
        can_read,
        can_write,
        can_delete,
        owner_id,
    )


class TestWorkspaceKeyStorage:
    async def test_get_or_create_master_key_is_consistent(self, db_pool, test_user) -> None:
        """Calling get_or_create twice returns the same master key bytes."""
        storage = WorkspaceKeyStorage(db_pool)
        workspace_uuid = test_user["workspace_uuid"]

        key1 = await storage.get_or_create_master_key(workspace_uuid, settings.secret_key)
        key2 = await storage.get_or_create_master_key(workspace_uuid, settings.secret_key)

        assert len(key1) == 32
        assert key1 == key2

    async def test_master_key_is_wrapped_with_workspace_key(self, db_pool, test_user) -> None:
        """The persisted master key can be decrypted with the workspace-derived key."""
        storage = WorkspaceKeyStorage(db_pool)
        workspace_uuid = test_user["workspace_uuid"]
        secret = settings.secret_key

        master_key = await storage.get_or_create_master_key(workspace_uuid, secret)

        async with db_pool.acquire() as conn:
            row = await conn.fetchrow(
                "SELECT master_key_ciphertext, master_key_iv FROM workspace_key WHERE workspace_id = $1",
                workspace_uuid,
            )

        assert row is not None
        workspace_key = derive_workspace_key(workspace_uuid, secret)
        decrypted = unwrap_key(
            {"ciphertext": row["master_key_ciphertext"], "iv": row["master_key_iv"]},
            workspace_key,
        )
        assert decrypted == master_key

    async def test_get_wrapped_key_for_user_creates_and_returns_key(self, db_pool, test_user) -> None:
        """A member can retrieve a wrapped copy of the workspace master key."""
        storage = WorkspaceKeyStorage(db_pool)
        workspace_uuid = test_user["workspace_uuid"]
        user_uuid = test_user["uuid"]
        secret = settings.secret_key

        wrapped = await storage.get_wrapped_key_for_user(workspace_uuid, user_uuid, secret)

        assert wrapped["workspace_id"] == workspace_uuid
        assert wrapped["user_id"] == user_uuid
        assert wrapped["key_version"] == 1
        assert "ciphertext" in wrapped
        assert "iv" in wrapped

        user_wrapping_key = derive_user_wrapping_key(user_uuid, secret)
        master_key = await storage.get_or_create_master_key(workspace_uuid, secret)
        decrypted = unwrap_key(wrapped, user_wrapping_key)
        assert decrypted == master_key

    async def test_rotate_master_key_updates_version_and_rewraps(self, db_pool, test_user) -> None:
        """Rotating the master key bumps the version and re-wraps member keys."""
        storage = WorkspaceKeyStorage(db_pool)
        workspace_uuid = test_user["workspace_uuid"]
        user_uuid = test_user["uuid"]
        secret = settings.secret_key

        old_wrapped = await storage.get_wrapped_key_for_user(workspace_uuid, user_uuid, secret)
        old_master = unwrap_key(old_wrapped, derive_user_wrapping_key(user_uuid, secret))

        await storage.rotate_master_key(workspace_uuid, secret)

        new_wrapped = await storage.get_wrapped_key_for_user(workspace_uuid, user_uuid, secret)
        new_master = unwrap_key(new_wrapped, derive_user_wrapping_key(user_uuid, secret))

        assert new_wrapped["key_version"] == old_wrapped["key_version"] + 1
        assert len(new_master) == 32
        assert new_master != old_master

        async with db_pool.acquire() as conn:
            row = await conn.fetchrow(
                "SELECT version FROM workspace_key WHERE workspace_id = $1",
                workspace_uuid,
            )
        assert row is not None
        assert row["version"] == new_wrapped["key_version"]


class TestKeyManagementService:
    async def test_owner_can_retrieve_key(self, db_pool, test_user) -> None:
        """The workspace owner can retrieve their wrapped key."""
        service = KeyManagementService(WorkspaceKeyStorage(db_pool))
        workspace_uuid = test_user["workspace_uuid"]
        actor_id = test_user["uuid"]

        result = await service.get_key(workspace_uuid, actor_id)

        assert result["workspace_id"] == workspace_uuid
        assert result["user_id"] == actor_id
        assert "ciphertext" in result

    async def test_shared_member_can_retrieve_key(self, db_pool, test_user) -> None:
        """A non-owner workspace member can retrieve their wrapped key."""
        service = KeyManagementService(WorkspaceKeyStorage(db_pool))
        workspace_id = test_user["workspace_id"]
        workspace_uuid = test_user["workspace_uuid"]
        owner_id = int(test_user["id"])

        member = await _create_user(f"member_{secrets.token_hex(4)}@example.com")
        async with db_pool.acquire() as conn:
            await _create_workspace_share(
                conn, workspace_id, int(member["id"]), owner_id, can_read=True, can_write=True
            )

        result = await service.get_key(workspace_uuid, member["uuid"])
        assert result["workspace_id"] == workspace_uuid
        assert result["user_id"] == member["uuid"]

    async def test_non_member_cannot_retrieve_key(self, db_pool, test_user) -> None:
        """A user who is not a workspace member is denied."""
        service = KeyManagementService(WorkspaceKeyStorage(db_pool))
        workspace_uuid = test_user["workspace_uuid"]
        outsider = await _create_user(f"outsider_{secrets.token_hex(4)}@example.com")

        with pytest.raises(PermissionDeniedError):
            await service.get_key(workspace_uuid, outsider["uuid"])

    async def test_owner_can_invite_member(self, db_pool, test_user) -> None:
        """An owner can invite a user and receive their wrapped key."""
        service = KeyManagementService(WorkspaceKeyStorage(db_pool))
        workspace_uuid = test_user["workspace_uuid"]
        owner_id = test_user["uuid"]
        target = await _create_user(f"invited_{secrets.token_hex(4)}@example.com")

        result = await service.invite_member(workspace_uuid, owner_id, target["uuid"])

        assert result["workspace_id"] == workspace_uuid
        assert result["user_id"] == target["uuid"]

        # The invited user should now be able to retrieve their own key.
        await service.get_key(workspace_uuid, target["uuid"])

    async def test_non_admin_cannot_invite(self, db_pool, test_user) -> None:
        """A regular member cannot invite another user."""
        service = KeyManagementService(WorkspaceKeyStorage(db_pool))
        workspace_id = test_user["workspace_id"]
        workspace_uuid = test_user["workspace_uuid"]
        owner_id = int(test_user["id"])

        member = await _create_user(f"member_{secrets.token_hex(4)}@example.com")
        target = await _create_user(f"target_{secrets.token_hex(4)}@example.com")
        async with db_pool.acquire() as conn:
            await _create_workspace_share(
                conn, workspace_id, int(member["id"]), owner_id, can_read=True, can_write=True
            )

        with pytest.raises(PermissionDeniedError):
            await service.invite_member(workspace_uuid, member["uuid"], target["uuid"])

    async def test_admin_can_invite_member(self, db_pool, test_user) -> None:
        """An admin member can invite a user and receive their wrapped key."""
        service = KeyManagementService(WorkspaceKeyStorage(db_pool))
        workspace_id = test_user["workspace_id"]
        workspace_uuid = test_user["workspace_uuid"]
        owner_id = int(test_user["id"])

        admin = await _create_user(f"admin_{secrets.token_hex(4)}@example.com")
        target = await _create_user(f"target_{secrets.token_hex(4)}@example.com")
        async with db_pool.acquire() as conn:
            await _create_workspace_share(
                conn, workspace_id, int(admin["id"]), owner_id, can_read=True, can_write=True, can_delete=True
            )

        result = await service.invite_member(workspace_uuid, admin["uuid"], target["uuid"])
        assert result["workspace_id"] == workspace_uuid
        assert result["user_id"] == target["uuid"]

    async def test_owner_can_rotate_key(self, db_pool, test_user) -> None:
        """An owner can rotate the workspace key."""
        service = KeyManagementService(WorkspaceKeyStorage(db_pool))
        workspace_uuid = test_user["workspace_uuid"]
        actor_id = test_user["uuid"]

        await service.get_key(workspace_uuid, actor_id)  # ensure key exists
        result = await service.rotate_key(workspace_uuid, actor_id)

        assert result["workspace_id"] == workspace_uuid
        assert result["key_version"] >= 2

    async def test_member_cannot_rotate_key(self, db_pool, test_user) -> None:
        """A non-admin member cannot rotate the workspace key."""
        service = KeyManagementService(WorkspaceKeyStorage(db_pool))
        workspace_id = test_user["workspace_id"]
        workspace_uuid = test_user["workspace_uuid"]
        owner_id = int(test_user["id"])

        member = await _create_user(f"member_{secrets.token_hex(4)}@example.com")
        async with db_pool.acquire() as conn:
            await _create_workspace_share(
                conn, workspace_id, int(member["id"]), owner_id, can_read=True, can_write=True
            )

        with pytest.raises(PermissionDeniedError):
            await service.rotate_key(workspace_uuid, member["uuid"])


class TestKeyRouter:
    async def test_get_key_endpoint_returns_wrapped_key(
        self, authenticated_client, test_user
    ) -> None:
        """The GET endpoint returns the authenticated user's wrapped key."""
        workspace_uuid = test_user["workspace_uuid"]
        response = await authenticated_client.get(f"/api/relay/keys/{workspace_uuid}")

        assert response.status_code == 200
        data = response.json()
        assert data["workspace_id"] == workspace_uuid
        assert data["user_id"] == test_user["uuid"]
        assert "ciphertext" in data
        assert "iv" in data
        assert data["key_version"] == 1

    async def test_get_key_endpoint_requires_auth(self, client, test_user) -> None:
        """Unauthenticated requests to the key endpoint are rejected."""
        workspace_uuid = test_user["workspace_uuid"]
        response = await client.get(f"/api/relay/keys/{workspace_uuid}")

        assert response.status_code == 401

    async def test_invite_endpoint_requires_owner_or_admin(
        self, authenticated_client, db_pool, test_user
    ) -> None:
        """The invite endpoint rejects non-admin members."""
        workspace_id = test_user["workspace_id"]
        workspace_uuid = test_user["workspace_uuid"]
        owner_id = int(test_user["id"])

        member = await _create_user(f"member_{secrets.token_hex(4)}@example.com")
        target = await _create_user(f"target_{secrets.token_hex(4)}@example.com")
        async with db_pool.acquire() as conn:
            await _create_workspace_share(
                conn, workspace_id, int(member["id"]), owner_id, can_read=True, can_write=True
            )

        token = auth.create_token(member["id"], member["email"], member["role"])
        headers = {"Authorization": f"Bearer {token}"}
        response = await authenticated_client.post(
            f"/api/relay/keys/{workspace_uuid}/invite",
            json={"target_user_id": target["uuid"]},
            headers=headers,
        )

        assert response.status_code == 403

    async def test_rotate_endpoint_requires_owner_or_admin(
        self, authenticated_client, db_pool, test_user
    ) -> None:
        """The rotate endpoint rejects non-admin members."""
        workspace_id = test_user["workspace_id"]
        workspace_uuid = test_user["workspace_uuid"]
        owner_id = int(test_user["id"])

        member = await _create_user(f"member_{secrets.token_hex(4)}@example.com")
        async with db_pool.acquire() as conn:
            await _create_workspace_share(
                conn, workspace_id, int(member["id"]), owner_id, can_read=True, can_write=True
            )

        token = auth.create_token(member["id"], member["email"], member["role"])
        headers = {"Authorization": f"Bearer {token}"}
        response = await authenticated_client.post(
            f"/api/relay/keys/{workspace_uuid}/rotate",
            json={},
            headers=headers,
        )

        assert response.status_code == 403

    async def test_owner_can_invite_via_endpoint(self, authenticated_client, test_user) -> None:
        """The owner can invite a user through the invite endpoint."""
        workspace_uuid = test_user["workspace_uuid"]
        target = await _create_user(f"invited_{secrets.token_hex(4)}@example.com")

        response = await authenticated_client.post(
            f"/api/relay/keys/{workspace_uuid}/invite",
            json={"target_user_id": target["uuid"]},
        )

        assert response.status_code == 200
        data = response.json()
        assert data["workspace_id"] == workspace_uuid
        assert data["user_id"] == target["uuid"]

    async def test_owner_can_rotate_via_endpoint(self, authenticated_client, test_user) -> None:
        """The owner can rotate the workspace key through the rotate endpoint."""
        workspace_uuid = test_user["workspace_uuid"]

        await authenticated_client.get(f"/api/relay/keys/{workspace_uuid}")
        response = await authenticated_client.post(
            f"/api/relay/keys/{workspace_uuid}/rotate",
            json={},
        )

        assert response.status_code == 200
        data = response.json()
        assert data["workspace_id"] == workspace_uuid
        assert data["key_version"] >= 2
