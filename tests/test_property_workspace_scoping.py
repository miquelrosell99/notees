"""Regression tests: property UUID lookups must resolve per workspace.

System properties (e.g. "Status") are seeded per workspace with identical
UUIDs, so a bare ``WHERE uuid = $1`` lookup can resolve to another
workspace's copy — property writes then assign foreign-workspace properties
to nodes. ``get_by_uuid``/``get_by_uuids`` must prefer the repository's own
workspace copy and only fall back to workspace-agnostic (NULL) rows.
"""

import secrets

import asyncpg
import pytest

from app.db import schema
from app.domain.entities import generate_uuid
from app.domain.entities.constants import SYSTEM_PROPERTY_UUIDS
from app.features.properties.repository import PostgresPropertyRepository

STATUS_UUID = SYSTEM_PROPERTY_UUIDS["task_status"]


async def _rerun_startup_schema(database_url: str) -> None:
    """Re-run the schema exactly the way backend startup does.

    main.py calls init_database(conn) on every startup; the db_pool fixture
    does it once on a fresh schema. This repeats it on the live database to
    simulate a container restart.
    """
    conn = await asyncpg.connect(database_url)
    try:
        await schema.init_database(conn)
    finally:
        await conn.close()


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


async def _selection_line_id(db_pool, property_id: int, name: str) -> int:
    """Internal id of a property's selection line by name."""
    line_id = await db_pool.fetchval(
        "SELECT id FROM property_selection_line "
        "WHERE property_id = $1 AND name = $2",
        property_id,
        name,
    )
    assert line_id is not None, "seed must create Status options per workspace"
    return line_id


async def _assign(db_pool, node_id: int, property_id: int, line_id: int) -> int:
    """Insert a node_property row plus one selection value; return its id."""
    np_id = await db_pool.fetchval(
        "INSERT INTO node_property (node_id, property_id) "
        "VALUES ($1, $2) RETURNING id",
        node_id,
        property_id,
    )
    await db_pool.execute(
        """
        INSERT INTO property_value_selection
            (node_property_id, property_id, node_id, selection_line_id)
        VALUES ($1, $2, $3, $4)
        """,
        np_id,
        property_id,
        node_id,
        line_id,
    )
    return np_id


async def _cross_workspace_count(db_pool) -> int:
    """Number of node_property rows whose property belongs to another workspace."""
    return await db_pool.fetchval(
        """
        SELECT count(*) FROM node_property np
        JOIN node n ON n.id = np.node_id
        JOIN property p ON p.id = np.property_id
        WHERE p.workspace_id IS NOT NULL AND p.workspace_id <> n.workspace_id
        """
    )


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


@pytest.mark.asyncio
async def test_startup_repair_cleans_cross_workspace_assignments(
    db_pool, test_user, database_url: str
):
    """The startup repair dedupes/remaps cross-workspace property assignments.

    Before property UUID lookups were workspace-scoped, writes could assign
    workspace B's copy of a per-workspace seeded property (e.g. Status) to a
    node in workspace A. The idempotent repair block in SCHEMA_SQL must:
    (a) delete the foreign assignment when the node also has its own
        workspace's assignment of the same property UUID (duplicate), and
    (b) remap the foreign assignment to the node's own workspace copy when it
        is the only one, re-pointing the selection value to the same-named
        line of the workspace copy.
    """
    user_id = int(test_user["id"])
    ws_a = test_user["workspace_id"]
    ws_b = await _seed_second_workspace(db_pool, user_id)

    status_a = await _status_property_id(db_pool, ws_a)
    status_b = await _status_property_id(db_pool, ws_b)

    pending_a = await _selection_line_id(db_pool, status_a, "Pending")
    done_a = await _selection_line_id(db_pool, status_a, "Done")
    done_b = await _selection_line_id(db_pool, status_b, "Done")

    # Two plain (non-task) nodes in workspace A.
    node_rows = await db_pool.fetch(
        """
        INSERT INTO node (workspace_id, name)
        VALUES ($1, 'RepairNode1'), ($1, 'RepairNode2')
        RETURNING id
        """,
        ws_a,
    )
    node1_id, node2_id = (row["id"] for row in node_rows)

    # (a) node1 has its own assignment of A's Status plus a duplicate foreign
    # assignment of B's Status (value: B's "Done" line).
    np_own = await _assign(db_pool, node1_id, status_a, pending_a)
    np_dup = await _assign(db_pool, node1_id, status_b, done_b)
    # (b) node2's only Status assignment points at B's property.
    np_foreign = await _assign(db_pool, node2_id, status_b, done_b)

    assert await _cross_workspace_count(db_pool) == 2, (
        "fixture must create exactly the contaminated rows"
    )

    # When: the startup schema runs again (simulated container restart).
    await _rerun_startup_schema(database_url)

    # Then (a): the foreign duplicate is gone; the own assignment and its
    # value are untouched.
    assert await db_pool.fetchval(
        "SELECT count(*) FROM node_property WHERE id = $1", np_dup
    ) == 0
    own_row = await db_pool.fetchrow(
        """
        SELECT np.property_id, pvs.selection_line_id
        FROM node_property np
        JOIN property_value_selection pvs ON pvs.node_property_id = np.id
        WHERE np.id = $1
        """,
        np_own,
    )
    assert own_row is not None, "the node's own assignment must survive the repair"
    assert own_row["property_id"] == status_a
    assert own_row["selection_line_id"] == pending_a

    # Then (b): the assignment is re-pointed to A's property with the
    # same-named ("Done") line of A's copy.
    remapped = await db_pool.fetchrow(
        """
        SELECT np.property_id, pvs.property_id AS value_property_id,
               pvs.selection_line_id
        FROM node_property np
        JOIN property_value_selection pvs ON pvs.node_property_id = np.id
        WHERE np.id = $1
        """,
        np_foreign,
    )
    assert remapped is not None, "a lone foreign assignment must be remapped, not dropped"
    assert remapped["property_id"] == status_a
    assert remapped["value_property_id"] == status_a
    assert remapped["selection_line_id"] == done_a

    # No cross-workspace assignments remain.
    assert await _cross_workspace_count(db_pool) == 0

    # Idempotent: a second simulated restart changes nothing.
    await _rerun_startup_schema(database_url)
    assert await db_pool.fetchval(
        "SELECT property_id FROM node_property WHERE id = $1", np_foreign
    ) == status_a
    assert await _cross_workspace_count(db_pool) == 0


@pytest.mark.asyncio
async def test_startup_repair_remaps_single_row_per_node_and_property_uuid(
    db_pool, test_user, database_url: str
):
    """Regression: foreign assignments of the same UUID from two foreign
    workspaces on one node must not crash the remap.

    Both foreign rows used to pass the remap guard (evaluated against the
    pre-statement snapshot) and were re-pointed to the same workspace copy,
    aborting startup with a UniqueViolationError on
    UNIQUE(node_id, property_id). Only one row per (node, UUID) may win the
    remap; the other must be swept as still-cross-workspace.
    """
    user_id = int(test_user["id"])
    ws_a = test_user["workspace_id"]
    ws_b = await _seed_second_workspace(db_pool, user_id)
    ws_c = await _seed_second_workspace(db_pool, user_id)

    status_a = await _status_property_id(db_pool, ws_a)
    status_b = await _status_property_id(db_pool, ws_b)
    status_c = await _status_property_id(db_pool, ws_c)

    done_a = await _selection_line_id(db_pool, status_a, "Done")
    done_b = await _selection_line_id(db_pool, status_b, "Done")
    done_c = await _selection_line_id(db_pool, status_c, "Done")

    # Plain (non-task) node in workspace A with NO own Status assignment but
    # two foreign ones: B's Status and C's Status (same system UUID).
    node_id = await db_pool.fetchval(
        "INSERT INTO node (workspace_id, name) VALUES ($1, 'RepairNode3') RETURNING id",
        ws_a,
    )
    np_first = await _assign(db_pool, node_id, status_b, done_b)
    np_second = await _assign(db_pool, node_id, status_c, done_c)
    assert np_first < np_second

    assert await _cross_workspace_count(db_pool) == 2

    # When: the startup schema runs again. Must not raise (previously crashed
    # with UniqueViolationError on node_property_node_id_property_id_key).
    await _rerun_startup_schema(database_url)

    # Then: the lowest-id foreign row wins the remap to A's copy (its value
    # re-pointed by line name); the other foreign row is swept.
    winner = await db_pool.fetchrow(
        """
        SELECT np.property_id, pvs.selection_line_id
        FROM node_property np
        JOIN property_value_selection pvs ON pvs.node_property_id = np.id
        WHERE np.id = $1
        """,
        np_first,
    )
    assert winner is not None
    assert winner["property_id"] == status_a
    assert winner["selection_line_id"] == done_a
    assert await db_pool.fetchval(
        "SELECT count(*) FROM node_property WHERE id = $1", np_second
    ) == 0

    # Exactly one Status assignment remains on the node, and no
    # cross-workspace rows survive.
    assert await db_pool.fetchval(
        "SELECT count(*) FROM node_property WHERE node_id = $1 AND property_id = $2",
        node_id,
        status_a,
    ) == 1
    assert await _cross_workspace_count(db_pool) == 0

    # Idempotent: a second simulated restart must not raise and changes nothing.
    await _rerun_startup_schema(database_url)
    assert await db_pool.fetchval(
        "SELECT property_id FROM node_property WHERE id = $1", np_first
    ) == status_a
    assert await _cross_workspace_count(db_pool) == 0
