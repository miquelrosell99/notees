"""Integration tests for workspace pending invites after the schema v5
``pending_invite.node_id`` -> ``node_uuid`` migration.

Workspace-level invites use the workspace's own UUID as ``node_uuid`` (the
workspace root node reference); node-level invites carry the shared node's
UUID and must not leak into workspace member listings.
"""

import uuid as uuid_module

from app.db.connection import acquire_connection
from app.features.workspaces.repository import PostgresWorkspaceRepository


async def test_create_pending_invite_inserts_workspace_level_row(db_pool, test_user):
    repo = PostgresWorkspaceRepository(db_pool)
    workspace_id = test_user["workspace_id"]
    email = "invitee@example.com"

    token = await repo.create_pending_invite(workspace_id, email, "editor", int(test_user["id"]))

    async with acquire_connection(db_pool) as conn:
        row = await conn.fetchrow(
            """
            SELECT uuid::text as uuid, email, role, node_uuid::text as node_uuid, active
            FROM pending_invite
            WHERE workspace_id = $1 AND email = $2
            """,
            workspace_id,
            email,
        )
    assert row is not None
    assert row["uuid"] == token
    assert row["role"] == "editor"
    assert row["active"] is True
    assert row["node_uuid"] == test_user["workspace_uuid"]


async def test_create_pending_invite_upserts_on_conflict(db_pool, test_user):
    repo = PostgresWorkspaceRepository(db_pool)
    workspace_id = test_user["workspace_id"]
    email = "invitee@example.com"

    first_token = await repo.create_pending_invite(workspace_id, email, "viewer", int(test_user["id"]))
    await repo.create_pending_invite(workspace_id, email, "editor", int(test_user["id"]))

    async with acquire_connection(db_pool) as conn:
        rows = await conn.fetch(
            "SELECT uuid::text as uuid, role FROM pending_invite WHERE workspace_id = $1 AND email = $2",
            workspace_id,
            email,
        )
    assert len(rows) == 1
    assert rows[0]["role"] == "editor"
    # Upsert keeps the originally issued invite token.
    assert rows[0]["uuid"] == first_token


async def test_list_members_returns_only_workspace_level_pending_invites(db_pool, test_user):
    repo = PostgresWorkspaceRepository(db_pool)
    workspace_id = test_user["workspace_id"]

    await repo.create_pending_invite(workspace_id, "pending@example.com", "viewer", int(test_user["id"]))

    # A node-level invite (different node_uuid) must not appear as a workspace invite.
    async with acquire_connection(db_pool) as conn:
        await conn.execute(
            """
            INSERT INTO pending_invite (email, workspace_id, node_uuid, role, invited_by)
            VALUES ($1, $2, $3, $4, $5)
            """,
            "node-level@example.com",
            workspace_id,
            str(uuid_module.uuid4()),
            "viewer",
            int(test_user["id"]),
        )

    result = await repo.list_members(workspace_id, page=1, page_size=20)
    pending_emails = {p["email"] for p in result["pending"]}
    assert "pending@example.com" in pending_emails
    assert "node-level@example.com" not in pending_emails


async def test_remove_pending_invite_deactivates_workspace_invite(db_pool, test_user):
    repo = PostgresWorkspaceRepository(db_pool)
    workspace_id = test_user["workspace_id"]
    email = "pending@example.com"

    await repo.create_pending_invite(workspace_id, email, "viewer", int(test_user["id"]))
    await repo.remove_pending_invite(workspace_id, email)

    async with acquire_connection(db_pool) as conn:
        row = await conn.fetchrow(
            "SELECT active FROM pending_invite WHERE workspace_id = $1 AND email = $2",
            workspace_id,
            email,
        )
    assert row is not None
    assert row["active"] is False

    result = await repo.list_members(workspace_id, page=1, page_size=20)
    assert email not in {p["email"] for p in result["pending"]}
