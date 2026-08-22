#!/usr/bin/env python3
"""Seed the operation relay from existing PostgreSQL workspaces.

Reads every workspace (or a single one via ``--workspace-id``), replays the
Phase 2 migration to generate ideal operations, and posts batches to the local
relay endpoint ``/api/relay/batch``.

The relay deduplicates by envelope id, so the script is safe to run multiple
times for the same workspace.

Usage::

    python scripts/seed_relay_from_postgres.py --all
    python scripts/seed_relay_from_postgres.py --workspace-id <uuid>
"""

from __future__ import annotations

import argparse
import asyncio
import os
import sys
from pathlib import Path
from typing import Any
from uuid import UUID

import asyncpg
import httpx

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.config import settings
from app.core.clock import Hlc
from app.core.migration import (
    connect_postgres,
    create_migration_context,
    migrate_assets_for_workspace,
    migrate_links_for_workspace,
    migrate_nodes_for_workspace,
    migrate_properties_for_workspace,
)
from app.core.migration.replay import replay_operations
from app.core.migration.validation import (
    DerivedCounts,
    build_reconciliation_report,
    get_derived_counts,
)
from app.core.migration.writer import InMemoryOperationWriter
from app.core.operation import create_operation
from app.relay.models import RelayEnvelope
from app.relay.storage import SqliteRelayStorage

DEFAULT_RELAY_URL = "http://localhost:8001"
BATCH_SIZE = 100


def _default_relay_storage_path() -> str:
    """Return the on-disk path used by the running backend for relay storage."""
    db_path = Path(settings.database_dir) / "relay" / "relay.db"
    db_path.parent.mkdir(parents=True, exist_ok=True)
    return str(db_path)


async def _workspace_int_id(conn: asyncpg.Connection, workspace_uuid: str) -> int | None:
    row = await conn.fetchrow(
        "SELECT id FROM workspace WHERE uuid = $1",
        UUID(workspace_uuid),
    )
    return row["id"] if row else None


async def _fetch_all_workspace_uuids(conn: asyncpg.Connection) -> list[str]:
    rows = await conn.fetch("SELECT uuid::text AS uuid FROM workspace ORDER BY id")
    return [row["uuid"] for row in rows]


async def _fetch_workspace_owner_uuid(conn: asyncpg.Connection, workspace_int_id: int) -> str | None:
    row = await conn.fetchrow(
        """
        SELECT u.uuid::text AS uuid
        FROM workspace w
        JOIN "user" u ON w.create_uid = u.id
        WHERE w.id = $1
        """,
        workspace_int_id,
    )
    return row["uuid"] if row else None


def _build_envelope(operation: Any) -> dict[str, Any]:
    return {
        "id": operation.envelope.id,
        "workspace_id": operation.envelope.workspace_id,
        "actor_id": operation.envelope.actor_id,
        "hlc": {
            "physical": operation.envelope.hlc.physical,
            "logical": operation.envelope.hlc.logical,
        },
        "affected_node_ids": operation.envelope.affected_node_ids,
        "op_type": operation.envelope.op_type,
        "payload": operation.payload,
    }


async def _seed_workspace(
    conn: asyncpg.Connection,
    workspace_uuid: str,
    secret_key: str,
    relay_url: str,
    copy_files: bool,
    direct: bool = False,
    storage: SqliteRelayStorage | None = None,
) -> tuple[int, list]:
    workspace_int_id = await _workspace_int_id(conn, workspace_uuid)
    if workspace_int_id is None:
        raise ValueError(f"Workspace {workspace_uuid} not found")

    owner_uuid = await _fetch_workspace_owner_uuid(conn, workspace_int_id)
    actor_id = owner_uuid or "system"

    writer = InMemoryOperationWriter()
    ctx = await create_migration_context(conn, workspace_int_id, actor_id)
    await migrate_nodes_for_workspace(conn, workspace_int_id, actor_id, writer, ctx=ctx)
    property_ops = await migrate_properties_for_workspace(conn, workspace_int_id, ctx)
    for op in property_ops:
        writer.write_operation(op)
    await migrate_links_for_workspace(conn, workspace_int_id, ctx, writer)
    await migrate_assets_for_workspace(
        conn, workspace_int_id, ctx, writer, copy_files=copy_files
    )

    envelopes = [_build_envelope(op) for op in writer.operations]

    if not envelopes:
        print(f"No operations generated for workspace {workspace_uuid}")
        writer.close()
        return 0, []

    if direct:
        if storage is None:
            raise ValueError("direct=True requires a SqliteRelayStorage instance")
        storage.save_envelopes([RelayEnvelope(**envelope) for envelope in envelopes])
        posted = len(envelopes)
    else:
        posted = 0
        async with httpx.AsyncClient(base_url=relay_url) as client:
            for i in range(0, len(envelopes), BATCH_SIZE):
                batch = envelopes[i : i + BATCH_SIZE]
                response = await client.post(
                    "/api/relay/batch",
                    json={"envelopes": batch},
                    headers={"x-actor-id": actor_id},
                )
                response.raise_for_status()
                data = response.json()
                posted += data.get("saved_count", 0)

    print(
        f"Seeded workspace {workspace_uuid}: {posted}/{len(envelopes)} operations saved"
    )
    operations = list(writer.operations)
    writer.close()
    return posted, operations


def _envelope_to_dict(envelope: RelayEnvelope) -> dict:
    """Serialize a stored envelope back into the dict format used by smoke tests."""
    return {
        "id": envelope.id,
        "workspace_id": envelope.workspace_id,
        "actor_id": envelope.actor_id,
        "hlc": {"physical": envelope.hlc.physical, "logical": envelope.hlc.logical},
        "affected_node_ids": envelope.affected_node_ids,
        "op_type": envelope.op_type,
        "payload": envelope.payload,
    }


async def _fetch_relay_operations(
    client: httpx.AsyncClient | None,
    workspace_uuid: str,
    actor_id: str,
    storage: SqliteRelayStorage | None = None,
) -> list[dict]:
    """Page through relay catch-up, either via HTTP or directly from storage."""
    if storage is not None:
        return [
            _envelope_to_dict(env)
            for env in storage.get_catch_up(workspace_uuid, 0)
        ]

    if client is None:
        raise ValueError("Either an httpx client or a SqliteRelayStorage instance is required")

    envelopes: list[dict] = []
    after_seq = 0
    while True:
        payload: dict = {
            "workspace_id": workspace_uuid,
            "after_seq": after_seq,
            "limit": 1000,
        }

        response = await client.post(
            "/api/relay/catch-up",
            json=payload,
            headers={"x-actor-id": actor_id},
        )
        response.raise_for_status()
        data = response.json()
        page = data.get("envelopes", [])
        envelopes.extend(page)
        if not data.get("has_more"):
            break
        after_seq = data["next_after_seq"]
    return envelopes


def _derive_counts_from_relay(
    workspace_uuid: str,
    secret_key: str,
    relay_envelopes: list[dict],
) -> DerivedCounts:
    """Replay relay envelopes into a fresh SQLite database."""
    operations = []
    for envelope in relay_envelopes:
        operations.append(
            create_operation(
                {
                    "id": envelope["id"],
                    "workspace_id": envelope["workspace_id"],
                    "actor_id": envelope["actor_id"],
                    "hlc": Hlc(
                        physical=envelope["hlc"]["physical"],
                        logical=envelope["hlc"]["logical"],
                    ),
                    "affected_node_ids": envelope["affected_node_ids"],
                    "op_type": envelope["op_type"],
                },
                envelope["payload"],
            )
        )
    operations.sort(key=lambda op: (op.envelope.hlc.physical, op.envelope.hlc.logical, op.envelope.id))
    conn = replay_operations(operations)
    try:
        return get_derived_counts(conn)
    finally:
        conn.close()


async def _smoke_test_workspace(
    conn: asyncpg.Connection,
    workspace_uuid: str,
    secret_key: str,
    relay_url: str,
    operations: list,
    direct: bool = False,
    storage: SqliteRelayStorage | None = None,
) -> bool:
    """Compare derived counts from relay replay against migration expectations."""
    workspace_int_id = await _workspace_int_id(conn, workspace_uuid)
    if workspace_int_id is None:
        print(f"  Smoke test skipped: workspace {workspace_uuid} not found")
        return False

    owner_uuid = await _fetch_workspace_owner_uuid(conn, workspace_int_id)
    actor_id = owner_uuid or "system"

    expected_report = build_reconciliation_report(operations)

    if direct:
        relay_envelopes = await _fetch_relay_operations(
            None, workspace_uuid, actor_id, storage=storage
        )
    else:
        async with httpx.AsyncClient(base_url=relay_url) as client:
            relay_envelopes = await _fetch_relay_operations(
                client, workspace_uuid, actor_id
            )

    actual_counts = _derive_counts_from_relay(workspace_uuid, secret_key, relay_envelopes)

    errors = []
    if actual_counts.node_count != expected_report.node_count:
        errors.append(
            f"node count mismatch: expected {expected_report.node_count}, got {actual_counts.node_count}"
        )
    if actual_counts.hierarchy_edge_count != expected_report.hierarchy_edge_count:
        errors.append(
            f"hierarchy edge count mismatch: expected {expected_report.hierarchy_edge_count}, got {actual_counts.hierarchy_edge_count}"
        )
    if actual_counts.property_count != expected_report.property_count:
        errors.append(
            f"property count mismatch: expected {expected_report.property_count}, got {actual_counts.property_count}"
        )
    if actual_counts.edge_count != expected_report.edge_count:
        errors.append(
            f"edge count mismatch: expected {expected_report.edge_count}, got {actual_counts.edge_count}"
        )

    if errors:
        print(f"  Smoke test FAILED for workspace {workspace_uuid}:")
        for error in errors:
            print(f"    - {error}")
        return False

    print(
        f"  Smoke test OK for workspace {workspace_uuid}: "
        f"{actual_counts.node_count} nodes, "
        f"{actual_counts.hierarchy_edge_count} hierarchy edges, "
        f"{actual_counts.property_count} properties, "
        f"{actual_counts.edge_count} edges"
    )
    return True


async def _run(args: argparse.Namespace) -> None:
    secret_key = settings.secret_key
    if not secret_key or len(secret_key) < 32:
        raise ValueError("SECRET_KEY must be set and at least 32 characters long")

    storage: SqliteRelayStorage | None = None
    if args.direct:
        storage = SqliteRelayStorage(_default_relay_storage_path())

    conn = await connect_postgres()
    try:
        if args.workspace_id:
            workspace_uuids = [args.workspace_id]
        else:
            workspace_uuids = await _fetch_all_workspace_uuids(conn)

        if not workspace_uuids:
            print("No workspaces found to seed")
            return

        total = 0
        smoke_passed = 0
        smoke_failed = 0
        for workspace_uuid in workspace_uuids:
            try:
                posted, operations = await _seed_workspace(
                    conn,
                    workspace_uuid,
                    secret_key,
                    args.relay_url,
                    copy_files=args.copy_files,
                    direct=args.direct,
                    storage=storage,
                )
                total += posted
                if args.smoke_test and operations:
                    ok = await _smoke_test_workspace(
                        conn,
                        workspace_uuid,
                        secret_key,
                        args.relay_url,
                        operations,
                        direct=args.direct,
                        storage=storage,
                    )
                    if ok:
                        smoke_passed += 1
                    else:
                        smoke_failed += 1
            except Exception as exc:
                print(f"Failed to seed workspace {workspace_uuid}: {exc}")
                if not args.continue_on_error:
                    raise
        print(f"Total operations seeded: {total}")
        if args.smoke_test:
            print(f"Smoke tests: {smoke_passed} passed, {smoke_failed} failed")
            if smoke_failed > 0:
                raise SystemExit(1)
    finally:
        await conn.close()
        if storage is not None:
            storage.close()


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Seed the operation relay from PostgreSQL workspaces."
    )
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument(
        "--all",
        action="store_true",
        help="Seed all workspaces in PostgreSQL.",
    )
    group.add_argument(
        "--workspace-id",
        type=str,
        help="Seed a single workspace by UUID.",
    )
    parser.add_argument(
        "--relay-url",
        type=str,
        default=os.getenv("NOTEES_RELAY_URL", DEFAULT_RELAY_URL),
        help=f"Base URL of the Notees backend. Default: {DEFAULT_RELAY_URL}",
    )
    parser.add_argument(
        "--copy-files",
        action=argparse.BooleanOptionalAction,
        default=True,
        help="Copy asset blobs to the content-addressed files tree. Default: true.",
    )
    parser.add_argument(
        "--continue-on-error",
        action="store_true",
        help="Continue seeding remaining workspaces if one fails.",
    )
    parser.add_argument(
        "--smoke-test",
        action="store_true",
        help="After seeding, replay relay operations and compare derived counts to the migration output.",
    )
    parser.add_argument(
        "--direct",
        action="store_true",
        help=(
            "Write envelopes directly to the relay SQLite storage instead of using the HTTP endpoint. "
            "Use this for one-time migrations or when workspaces lack an owner record."
        ),
    )
    args = parser.parse_args()
    asyncio.run(_run(args))


if __name__ == "__main__":
    main()
