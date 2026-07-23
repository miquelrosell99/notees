"""Permission-checker tests for the operation relay."""

from __future__ import annotations

import secrets

import pytest

from app.core.clock import Hlc
from app.features.auth import auth
from app.relay.models import BatchRequest, EncryptedEnvelope
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
    """Return a stable node UUID for share metadata.

    Nodes now live in the operation-log derived state; this helper only
    produces the UUID used by share records.
    """
    from uuid import uuid4

    return str(uuid4())


async def _create_public_share(conn, node_uuid: str, workspace_id: int, created_by: int) -> str:
    """Create an active, unexpired public share for a node and return its UUID."""
    row = await conn.fetchrow(
        """
        INSERT INTO node_public_share (node_uuid, workspace_id, created_by, active)
        VALUES ($1, $2, $3, TRUE)
        RETURNING uuid::text as uuid
        """,
        node_uuid,
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
        share_token = await _create_public_share(conn, node_uuid, workspace_id, owner_id)

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
        share_token = await _create_public_share(conn, node_uuid, workspace_id, owner_id)

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
        share_token = await _create_public_share(conn, node_uuid, workspace_id, owner_id)

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
        await _create_public_share(conn, node_uuid, workspace_id, owner_id)

    envelope = EncryptedEnvelope(
        id="env-public",
        workspace_id=workspace_uuid,
        actor_id="anonymous",
        hlc=Hlc(1, 0),
        affected_node_ids=[node_uuid],
        op_type="node.create",
        payload={"nodeId": "node-1"},
    )

    with pytest.raises(PermissionDeniedError):
        await service.receive_batch(BatchRequest(envelopes=[envelope]), "anonymous")


async def test_shared_editor_can_read_and_write_through_relay(db_pool, test_user) -> None:
    """A workspace member with write access can submit and receive operations."""
    checker = PostgresPermissionChecker(db_pool)
    storage = SqliteRelayStorage()
    service = RelayService(storage, checker)
    workspace_id = test_user["workspace_id"]
    workspace_uuid = test_user["workspace_uuid"]
    owner_id = int(test_user["id"])

    editor = await _create_user(f"editor_{secrets.token_hex(4)}@example.com")
    async with db_pool.acquire() as conn:
        await _create_workspace_share(
            conn, workspace_id, int(editor["id"]), owner_id, can_read=True, can_write=True
        )

    envelope = EncryptedEnvelope(
        id="env-editor-write",
        workspace_id=workspace_uuid,
        actor_id=editor["uuid"],
        hlc=Hlc(1, 0),
        affected_node_ids=["node-1"],
        op_type="node.create",
        payload={"nodeId": "node-1"},
    )

    saved = await service.receive_batch(BatchRequest(envelopes=[envelope]), editor["uuid"])
    assert len(saved) == 1

    caught_up = await service.catch_up(workspace_uuid, editor["uuid"], Hlc(0, 0))
    assert len(caught_up) == 1
    assert caught_up[0].id == "env-editor-write"


async def test_shared_viewer_can_read_but_not_write_through_relay(db_pool, test_user) -> None:
    """A workspace member with read-only access can catch up but cannot submit."""
    checker = PostgresPermissionChecker(db_pool)
    storage = SqliteRelayStorage()
    service = RelayService(storage, checker)
    workspace_id = test_user["workspace_id"]
    workspace_uuid = test_user["workspace_uuid"]
    owner_id = int(test_user["id"])

    viewer = await _create_user(f"viewer_{secrets.token_hex(4)}@example.com")
    async with db_pool.acquire() as conn:
        await _create_workspace_share(
            conn, workspace_id, int(viewer["id"]), owner_id, can_read=True, can_write=False
        )

    # Owner seeds an operation that the viewer should be able to read.
    owner_envelope = EncryptedEnvelope(
        id="env-owner",
        workspace_id=workspace_uuid,
        actor_id=test_user["uuid"],
        hlc=Hlc(1, 0),
        affected_node_ids=["node-1"],
        op_type="node.create",
        payload={"nodeId": "node-1"},
    )
    await service.receive_batch(BatchRequest(envelopes=[owner_envelope]), test_user["uuid"])

    caught_up = await service.catch_up(workspace_uuid, viewer["uuid"], Hlc(0, 0))
    assert len(caught_up) == 1

    viewer_envelope = EncryptedEnvelope(
        id="env-viewer",
        workspace_id=workspace_uuid,
        actor_id=viewer["uuid"],
        hlc=Hlc(2, 0),
        affected_node_ids=["node-1"],
        op_type="node.create",
        payload={"nodeId": "node-1"},
    )
    with pytest.raises(PermissionDeniedError):
        await service.receive_batch(BatchRequest(envelopes=[viewer_envelope]), viewer["uuid"])


async def test_revoked_share_immediately_loses_write_access(db_pool, test_user) -> None:
    """Deactivating a workspace share blocks further writes through the relay."""
    checker = PostgresPermissionChecker(db_pool)
    storage = SqliteRelayStorage()
    service = RelayService(storage, checker)
    workspace_id = test_user["workspace_id"]
    workspace_uuid = test_user["workspace_uuid"]
    owner_id = int(test_user["id"])

    editor = await _create_user(f"editor_{secrets.token_hex(4)}@example.com")
    async with db_pool.acquire() as conn:
        await _create_workspace_share(
            conn, workspace_id, int(editor["id"]), owner_id, can_read=True, can_write=True
        )

    envelope_before = EncryptedEnvelope(
        id="env-before-revoke",
        workspace_id=workspace_uuid,
        actor_id=editor["uuid"],
        hlc=Hlc(1, 0),
        affected_node_ids=["node-1"],
        op_type="node.create",
        payload={"nodeId": "node-1"},
    )
    saved = await service.receive_batch(
        BatchRequest(envelopes=[envelope_before]), editor["uuid"]
    )
    assert len(saved) == 1

    # Revoke the share.
    async with db_pool.acquire() as conn:
        await conn.execute(
            """
            UPDATE workspace_share
            SET active = FALSE, can_read = FALSE, can_write = FALSE,
                can_create = FALSE, can_delete = FALSE, write_uid = $1, write_date = NOW()
            WHERE workspace_id = $2 AND user_id = $3
            """,
            owner_id,
            workspace_id,
            int(editor["id"]),
        )

    envelope_after = EncryptedEnvelope(
        id="env-after-revoke",
        workspace_id=workspace_uuid,
        actor_id=editor["uuid"],
        hlc=Hlc(2, 0),
        affected_node_ids=["node-1"],
        op_type="node.create",
        payload={"nodeId": "node-1"},
    )
    with pytest.raises(PermissionDeniedError):
        await service.receive_batch(BatchRequest(envelopes=[envelope_after]), editor["uuid"])


async def test_public_share_catch_up_is_node_scoped(db_pool, test_user) -> None:
    """A public share token only returns envelopes affecting the shared node."""
    checker = PostgresPermissionChecker(db_pool)
    storage = SqliteRelayStorage()
    service = RelayService(storage, checker)
    workspace_id = test_user["workspace_id"]
    workspace_uuid = test_user["workspace_uuid"]
    owner_id = int(test_user["id"])

    async with db_pool.acquire() as conn:
        shared_node_uuid = await _create_node(conn, workspace_id, owner_id)
        other_node_uuid = await _create_node(conn, workspace_id, owner_id)
        share_token = await _create_public_share(
            conn, shared_node_uuid, workspace_id, owner_id
        )

    shared_envelope = EncryptedEnvelope(
        id="env-shared",
        workspace_id=workspace_uuid,
        actor_id=test_user["uuid"],
        hlc=Hlc(1, 0),
        affected_node_ids=[shared_node_uuid],
        op_type="node.updateContent",
        payload={"nodeId": shared_node_uuid, "content": []},
    )
    other_envelope = EncryptedEnvelope(
        id="env-other",
        workspace_id=workspace_uuid,
        actor_id=test_user["uuid"],
        hlc=Hlc(2, 0),
        affected_node_ids=[other_node_uuid],
        op_type="node.updateContent",
        payload={"nodeId": other_node_uuid, "content": []},
    )
    await service.receive_batch(
        BatchRequest(envelopes=[shared_envelope, other_envelope]), test_user["uuid"]
    )

    share_node_id = await service.get_public_share_node_id(
        workspace_uuid, share_token
    )
    assert share_node_id == shared_node_uuid

    result = await service.catch_up(
        workspace_uuid,
        "anonymous",
        Hlc(0, 0),
        share_token=share_token,
        share_node_id=share_node_id,
    )
    assert len(result) == 1
    assert result[0].id == "env-shared"
    assert result[0].affected_node_ids == [shared_node_uuid]
