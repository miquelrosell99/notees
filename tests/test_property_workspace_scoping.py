"""Regression tests: property UUID lookups must resolve per workspace.

System properties (e.g. "Status") are seeded per workspace with identical
UUIDs, so a bare ``WHERE uuid = $1`` lookup can resolve to another
workspace's copy — property writes then assign foreign-workspace properties
to nodes. ``get_by_uuid``/``get_by_uuids`` must prefer the repository's own
workspace copy and only fall back to workspace-agnostic (NULL) rows.
"""

import secrets

import pytest

from app.db import schema
from app.domain.entities import generate_uuid
from app.domain.entities.constants import SYSTEM_PROPERTY_UUIDS
from app.features.properties.repository import PostgresPropertyRepository

STATUS_UUID = SYSTEM_PROPERTY_UUIDS["task_status"]


async def _seed_second_workspace(db_pool, user_id: int) -> int:
    """Seed a second workspace through the exact production seeding path."""
    async with db_pool.acquire() as conn:
        return await schema.create_workspace_for_user(
            conn, user_id, name=f"ws2_{secrets.token_hex(4)}"
        )


async def _status_property_id(db_pool, workspace_id: int) -> int:
    """Internal id of a workspace's own 'Status' property row."""
    row = await db_pool.fetchrow(
        "SELECT id FROM property WHERE workspace_id = $1 AND uuid = $2 AND active = TRUE",
        workspace_id,
        STATUS_UUID,
    )
    assert row is not None, "seed must create a Status property per workspace"
    return row["id"]


@pytest.mark.asyncio
async def test_get_by_uuid_prefers_own_workspace_copy(db_pool, test_user):
    """Each workspace's repo resolves a duplicated system UUID to its own copy.

    Both repos run the same lookup; the assertions can only hold together when
    the lookup is scoped — unscoped, both resolve to one arbitrary row.
    """
    user_id = int(test_user["id"])
    ws_a = test_user["workspace_id"]
    ws_b = await _seed_second_workspace(db_pool, user_id)

    status_a = await _status_property_id(db_pool, ws_a)
    status_b = await _status_property_id(db_pool, ws_b)
    assert status_a != status_b

    repo_a = PostgresPropertyRepository(db_pool, ws_a, user_id)
    repo_b = PostgresPropertyRepository(db_pool, ws_b, user_id)

    prop_a = await repo_a.get_by_uuid(STATUS_UUID)
    prop_b = await repo_b.get_by_uuid(STATUS_UUID)
    assert prop_a is not None and prop_a.id == status_a
    assert prop_b is not None and prop_b.id == status_b


@pytest.mark.asyncio
async def test_get_by_uuids_scopes_per_workspace(db_pool, test_user):
    """Batch lookup from a workspace returns that workspace's copy only."""
    user_id = int(test_user["id"])
    ws_a = test_user["workspace_id"]
    ws_b = await _seed_second_workspace(db_pool, user_id)

    status_a = await _status_property_id(db_pool, ws_a)
    status_b = await _status_property_id(db_pool, ws_b)

    repo_a = PostgresPropertyRepository(db_pool, ws_a, user_id)
    repo_b = PostgresPropertyRepository(db_pool, ws_b, user_id)

    props_a = await repo_a.get_by_uuids([STATUS_UUID])
    props_b = await repo_b.get_by_uuids([STATUS_UUID])
    assert [p.id for p in props_a] == [status_a]
    assert [p.id for p in props_b] == [status_b]


@pytest.mark.asyncio
async def test_get_by_uuid_falls_back_to_null_workspace(db_pool, test_user):
    """A workspace-agnostic (workspace_id NULL) property still resolves.

    The current schema declares property.workspace_id NOT NULL (all seeding is
    per-workspace); the NULL fallback exists for rows from before that
    constraint, so drop it inside this test's fresh schema to create one.
    """
    user_id = int(test_user["id"])
    ws_a = test_user["workspace_id"]
    null_prop_uuid = generate_uuid()

    await db_pool.execute(
        "ALTER TABLE property ALTER COLUMN workspace_id DROP NOT NULL"
    )
    await db_pool.execute(
        """
        INSERT INTO property (uuid, workspace_id, name, type, is_multi, is_system, create_date, write_date)
        VALUES ($1, NULL, 'LegacyGlobalProp', 'boolean', FALSE, TRUE, NOW(), NOW())
        """,
        null_prop_uuid,
    )

    repo_a = PostgresPropertyRepository(db_pool, ws_a, user_id)
    prop = await repo_a.get_by_uuid(null_prop_uuid)
    assert prop is not None
    assert prop.uuid == null_prop_uuid
    assert prop.name == "LegacyGlobalProp"


@pytest.mark.asyncio
async def test_set_property_rejects_foreign_selection_line(db_pool, test_user, auth_client):
    """A selection-line UUID of another property must not persist on write.

    Both workspaces seed a "Status" selection property under the same system
    UUID. The property lookup is workspace-scoped, so the write below targets
    workspace A's own Status property — but the selection-line UUID belongs to
    workspace B's Status property. The service must reject the mismatched line
    (ValueError -> 400 in the values router) and persist nothing.
    """
    user_id = int(test_user["id"])
    ws_a = test_user["workspace_id"]
    ws_b = await _seed_second_workspace(db_pool, user_id)

    status_a = await _status_property_id(db_pool, ws_a)
    status_b = await _status_property_id(db_pool, ws_b)

    foreign_line_uuid = await db_pool.fetchval(
        "SELECT uuid::text FROM property_selection_line WHERE property_id = $1 LIMIT 1",
        status_b,
    )
    assert foreign_line_uuid is not None, "seed must create Status options per workspace"

    node_uuid = (await auth_client.post("/api/nodes/", json={"name": "N"})).json()["uuid"]

    resp = await auth_client.post(
        f"/api/nodes/{node_uuid}/properties",
        json={"property_uuid": STATUS_UUID, "value": foreign_line_uuid},
    )
    assert resp.status_code == 400, resp.text

    row_count = await db_pool.fetchval(
        """
        SELECT COUNT(*) FROM node_property np
        JOIN node n ON n.id = np.node_id
        WHERE n.uuid = $1 AND np.property_id = $2
        """,
        node_uuid,
        status_a,
    )
    assert row_count == 0
