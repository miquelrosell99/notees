#!/usr/bin/env python3
"""Seed the encrypted operation relay from existing PostgreSQL workspaces.

Reads every workspace (or a single one via ``--workspace-id``), replays the
Phase 2 migration to generate ideal operations, encrypts each operation with a
workspace-specific key derived from ``workspace_id + SECRET_KEY``, and posts
batches to the local relay endpoint ``/api/relay/batch``.

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
from typing import Any
from uuid import UUID

import asyncpg
import httpx

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.config import settings
from app.core.crypto import derive_workspace_key, encrypt_operation_payload
from app.core.migration import (
    connect_postgres,
    create_migration_context,
    migrate_assets_for_workspace,
    migrate_links_for_workspace,
    migrate_nodes_for_workspace,
    migrate_properties_for_workspace,
)
from app.core.migration.writer import InMemoryOperationWriter

DEFAULT_RELAY_URL = "http://localhost:8000"
BATCH_SIZE = 100


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
        JOIN "user" u ON w.owner_id = u.id
        WHERE w.id = $1
        """,
        workspace_int_id,
    )
    return row["uuid"] if row else None


def _build_envelope(operation: Any, key: bytes) -> dict[str, Any]:
    encrypted = encrypt_operation_payload(operation.payload, key)
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
        "ciphertext": encrypted["ciphertext"],
        "iv": encrypted["iv"],
    }


async def _seed_workspace(
    conn: asyncpg.Connection,
    workspace_uuid: str,
    secret_key: str,
    relay_url: str,
    copy_files: bool,
) -> int:
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

    key = derive_workspace_key(workspace_uuid, secret_key)
    envelopes = [_build_envelope(op, key) for op in writer.operations]
    writer.close()

    if not envelopes:
        print(f"No operations generated for workspace {workspace_uuid}")
        return 0

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
    return posted


async def _run(args: argparse.Namespace) -> None:
    secret_key = settings.secret_key
    if not secret_key or len(secret_key) < 32:
        raise ValueError("SECRET_KEY must be set and at least 32 characters long")

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
        for workspace_uuid in workspace_uuids:
            try:
                total += await _seed_workspace(
                    conn,
                    workspace_uuid,
                    secret_key,
                    args.relay_url,
                    copy_files=args.copy_files,
                )
            except Exception as exc:
                print(f"Failed to seed workspace {workspace_uuid}: {exc}")
                if not args.continue_on_error:
                    raise
        print(f"Total operations seeded: {total}")
    finally:
        await conn.close()


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Seed the encrypted operation relay from PostgreSQL workspaces."
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
    args = parser.parse_args()
    asyncio.run(_run(args))


if __name__ == "__main__":
    main()
