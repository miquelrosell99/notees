#!/usr/bin/env python3
"""Bulk-create relay snapshots for workspaces that do not have one.

This script is idempotent: it skips workspaces that already have a snapshot.
It replays the operation log server-side into a temporary derived SQLite
database, exports the serialized database bytes, and stores them as a
``relay_snapshot`` row. Because the current transport-layer encryption is a
no-op, the server can read operation payloads for this administrative task.

Example:
    uv run python scripts/admin_create_snapshots.py
    uv run python scripts/admin_create_snapshots.py --workspace-id 3b30e070-039b-47bc-ad0d-2440a2f173c5
"""

from __future__ import annotations

import argparse
import asyncio
import sys
from typing import Any

from dotenv import load_dotenv

from app.config import settings
from app.core.uuid import uuidv7
from app.core.workspace_store import WorkspaceStore
from app.db.connection import get_pool, setup_jsonb_codec
from app.relay.storage import PostgresRelayStorage


async def _fetch_workspace_ids(conn: Any) -> list[str]:
    """Return every workspace UUID that has relay envelopes."""
    rows = await conn.fetch(
        """
        SELECT DISTINCT workspace_id
        FROM relay_envelope
        ORDER BY workspace_id
        """
    )
    return [row["workspace_id"] for row in rows]


async def _has_snapshot(conn: Any, workspace_id: str) -> bool:
    """Return True if the workspace already has a non-empty snapshot."""
    row = await conn.fetchrow(
        """
        SELECT 1
        FROM relay_snapshot
        WHERE workspace_id = $1
          AND data IS NOT NULL
          AND OCTET_LENGTH(data) > 0
        LIMIT 1
        """,
        workspace_id,
    )
    return row is not None


async def _count_envelopes(conn: Any, workspace_id: str) -> int:
    row = await conn.fetchrow(
        "SELECT COUNT(*) FROM relay_envelope WHERE workspace_id = $1",
        workspace_id,
    )
    return row[0] if row else 0


async def _create_snapshot_for_workspace(
    workspace_id: str,
    storage: PostgresRelayStorage,
) -> dict[str, Any]:
    """Replay operations and upload a snapshot for a single workspace."""
    actor_id = f"system-snapshot-{uuidv7()}"
    store = WorkspaceStore(
        workspace_id=workspace_id,
        actor_id=actor_id,
        relay_storage=storage,
        db_path=":memory:",
        key_storage=None,
    )

    await store.sync()
    snapshot_id = await store.create_snapshot()
    return {"snapshot_id": snapshot_id, "workspace_id": workspace_id}


async def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Create relay snapshots for workspaces that do not have one"
    )
    parser.add_argument(
        "--workspace-id",
        type=str,
        help="Create a snapshot for a single workspace UUID",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Print what would be done without writing snapshots",
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="Create a snapshot even if one already exists",
    )
    args = parser.parse_args(argv)

    load_dotenv()

    pool = await get_pool()
    async with pool.acquire() as conn:
        await setup_jsonb_codec(conn)
        storage = PostgresRelayStorage(pool=pool)

        try:
            if args.workspace_id:
                workspace_ids = [args.workspace_id]
            else:
                workspace_ids = await _fetch_workspace_ids(conn)

            if not workspace_ids:
                print("No workspaces with relay envelopes found.")
                return 0

            processed = 0
            skipped = 0
            failed = 0

            for workspace_id in workspace_ids:
                has_snapshot = await _has_snapshot(conn, workspace_id)
                if has_snapshot and not args.force:
                    print(f"Skipping {workspace_id}: snapshot already exists")
                    skipped += 1
                    continue

                envelope_count = await _count_envelopes(conn, workspace_id)
                print(
                    f"Processing {workspace_id} ({envelope_count:,} envelope(s))",
                    flush=True,
                )

                if args.dry_run:
                    print(f"  would create snapshot for {workspace_id}")
                    continue

                try:
                    result = await _create_snapshot_for_workspace(
                        workspace_id, storage
                    )
                    print(
                        f"  created snapshot {result['snapshot_id']} for {workspace_id}",
                        flush=True,
                    )
                    processed += 1
                except Exception as exc:
                    print(
                        f"  ERROR creating snapshot for {workspace_id}: {exc}",
                        file=sys.stderr,
                        flush=True,
                    )
                    failed += 1

            print(
                f"Done: {processed} created, {skipped} skipped, {failed} failed "
                f"out of {len(workspace_ids)} workspace(s)"
            )
            return 1 if failed else 0
        finally:
            await storage.close()


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
