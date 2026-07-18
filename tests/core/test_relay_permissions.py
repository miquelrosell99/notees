"""Permission-checker tests for the operation relay."""

from __future__ import annotations

import secrets

import pytest

from app.features.auth import auth
from app.relay.permissions import PermissionDeniedError
from app.relay.permissions_postgres import PostgresPermissionChecker
from app.relay.service import RelayService
from app.relay.storage import SqliteRelayStorage

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
) -> None:
    """Insert an active workspace_share record with the given permissions."""
    await conn.execute(
        """
        INSERT INTO workspace_share (
            workspace_id, user_id, can_read, can_write, can_create, can_delete, can_comment,
            active, create_uid, write_uid
        )
        VALUES ($1, $2, $3, $4, $4, FALSE, FALSE, TRUE, $5, $5)
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
        owner_id,
    )


async def _create_node(conn, workspace_id: int, owner_id: int) -> str:
    """Create a simple page node and return its UUID."""
    row = await conn.fetchrow(
        """
        INSERT INTO node (workspace_id, name, is_page, active, create_uid, write_uid)
        VALUES ($1, $2, TRUE, TRUE, $3, $3)
        RETURNING uuid::text as uuid
        """,
        workspace_id,
        "Shared page",
        owner_id,
    )
    return row["uuid"]


async def _create_public_share(conn, node_id: int, workspace_id: int, created_by: int) -> str:
    """Create an active, unexpired public share for a node and return its UUID."""
    row = await conn.fetchrow(
        """
        INSERT INTO node_public_share (node_id, workspace_id, created_by, active)
        VALUES ($1, $2, $3, TRUE)
        RETURNING uuid::text as uuid
        """,
        node_id,
        workspace_id,
        created_by,
    )
    return row["uuid"]


async def test_owner_can_read_and_write(db_pool, test_user) -> None:
    checker = PostgresPermissionChecker(db_pool)
    workspace_uuid = test_user["workspace_uuid"]
    actor_id = test_user["uuid"]

    assert await checker.can_read(workspace_uuid, actor_id) is True
    assert await checker.can_write(workspace_uuid, actor_id, ["node-1"]) is True


async def test_shared_editor_can_read_and_write(db_pool, test_user) -> None:
    checker = PostgresPermissionChecker(db_pool)
    workspace_id = test_user["workspace_id"]
    workspace_uuid = test_user["workspace_uuid"]
    owner_id = int(test_user["id"])

    editor = await _create_user(f"editor_{secrets.token_hex(4)}@example.com")
    async with db_pool.acquire() as conn:
        await _create_workspace_share(
            conn, workspace_id, int(editor["id"]), owner_id, can_read=True, can_write=True
        )

    assert await checker.can_read(workspace_uuid, editor["uuid"]) is True
    assert await checker.can_write(workspace_uuid, editor["uuid"], ["node-1"]) is True


async def test_shared_viewer_can_read_but_not_write(db_pool, test_user) -> None:
    checker = PostgresPermissionChecker(db_pool)
    workspace_id = test_user["workspace_id"]
    workspace_uuid = test_user["workspace_uuid"]
    owner_id = int(test_user["id"])

    viewer = await _create_user(f"viewer_{secrets.token_hex(4)}@example.com")
    async with db_pool.acquire() as conn:
        await _create_workspace_share(
            conn, workspace_id, int(viewer["id"]), owner_id, can_read=True, can_write=False
        )

    assert await checker.can_read(workspace_uuid, viewer["uuid"]) is True
    assert await checker.can_write(workspace_uuid, viewer["uuid"], ["node-1"]) is False


async def test_anonymous_cannot_read_or_write(db_pool, test_user) -> None:
    checker = PostgresPermissionChecker(db_pool)
    workspace_uuid = test_user["workspace_uuid"]

    assert await checker.can_read(workspace_uuid, "anonymous") is False
    assert await checker.can_write(workspace_uuid, "anonymous", ["node-1"]) is False


async def test_public_share_token_grants_read_but_not_write(db_pool, test_user) -> None:
    checker = PostgresPermissionChecker(db_pool)
    workspace_id = test_user["workspace_id"]
    workspace_uuid = test_user["workspace_uuid"]
    owner_id = int(test_user["id"])

    async with db_pool.acquire() as conn:
        node_uuid = await _create_node(conn, workspace_id, owner_id)
        node_id_row = await conn.fetchrow(
            "SELECT id FROM node WHERE uuid::text = $1", node_uuid
        )
        node_id = node_id_row["id"]
        share_token = await _create_public_share(conn, node_id, workspace_id, owner_id)

    assert (
        await checker.can_read_public_share(workspace_uuid, share_token, node_uuid)
        is True
    )
    # A public share is read-only in the relay.
    assert await checker.can_write(workspace_uuid, "anonymous", [node_uuid]) is False


async def test_public_share_token_allows_anonymous_catch_up(db_pool, test_user) -> None:
    checker = PostgresPermissionChecker(db_pool)
    storage = SqliteRelayStorage()
    service = RelayService(storage, checker)
    workspace_id = test_user["workspace_id"]
    workspace_uuid = test_user["workspace_uuid"]
    owner_id = int(test_user["id"])

    async with db_pool.acquire() as conn:
        node_uuid = await _create_node(conn, workspace_id, owner_id)
        node_id_row = await conn.fetchrow(
            "SELECT id FROM node WHERE uuid::text = $1", node_uuid
        )
        node_id = node_id_row["id"]
        share_token = await _create_public_share(conn, node_id, workspace_id, owner_id)

    # Anonymous catch-up with a valid share token should succeed.
    from app.core.clock import Hlc

    result = await service.catch_up(workspace_uuid, "anonymous", Hlc(0, 0), share_token=share_token)
    assert result == []


async def test_public_share_token_without_node_scope_any_workspace_node(db_pool, test_user) -> None:
    """The prototype treats any active node share in the workspace as workspace access."""
    checker = PostgresPermissionChecker(db_pool)
    workspace_id = test_user["workspace_id"]
    workspace_uuid = test_user["workspace_uuid"]
    owner_id = int(test_user["id"])

    async with db_pool.acquire() as conn:
        node_uuid = await _create_node(conn, workspace_id, owner_id)
        node_id_row = await conn.fetchrow(
            "SELECT id FROM node WHERE uuid::text = $1", node_uuid
        )
        node_id = node_id_row["id"]
        share_token = await _create_public_share(conn, node_id, workspace_id, owner_id)

    # Calling without a specific node_id still matches because the workspace has
    # at least one active public share.
    assert await checker.can_read_public_share(workspace_uuid, share_token) is True


async def test_unknown_actor_denied(db_pool, test_user) -> None:
    checker = PostgresPermissionChecker(db_pool)
    workspace_uuid = test_user["workspace_uuid"]

    assert await checker.can_read(workspace_uuid, "00000000-0000-0000-0000-000000000000") is False
    assert await checker.can_write(workspace_uuid, "00000000-0000-0000-0000-000000000000", ["node-1"]) is False


async def test_public_share_write_rejected_via_service(db_pool, test_user) -> None:
    """Submitting a batch as anonymous with a public share token still fails."""
    checker = PostgresPermissionChecker(db_pool)
    storage = SqliteRelayStorage()
    service = RelayService(storage, checker)
    workspace_id = test_user["workspace_id"]
    workspace_uuid = test_user["workspace_uuid"]
    owner_id = int(test_user["id"])

    async with db_pool.acquire() as conn:
        node_uuid = await _create_node(conn, workspace_id, owner_id)
        node_id_row = await conn.fetchrow(
            "SELECT id FROM node WHERE uuid::text = $1", node_uuid
        )
        node_id = node_id_row["id"]
        share_token = await _create_public_share(conn, node_id, workspace_id, owner_id)

    from app.core.clock import Hlc
    from app.relay.models import BatchRequest, EncryptedEnvelope

    envelope = EncryptedEnvelope(
        id="env-public",
        workspace_id=workspace_uuid,
        actor_id="anonymous",
        hlc=Hlc(1, 0),
        affected_node_ids=[node_uuid],
        op_type="node.create",
        ciphertext="ZW5jcnlwdGVk",
        iv="c3R1Yml2",
    )

    with pytest.raises(PermissionDeniedError):
        await service.receive_batch(BatchRequest(envelopes=[envelope]), "anonymous")
