#!/usr/bin/env python3
"""Compact relay operation logs by pruning old envelopes.

Compaction creates a snapshot of the derived state up to a computed HLC,
records a compaction segment, and deletes the pruned envelopes. Clients
that open the workspace after compaction restore the snapshot and replay
only the remaining envelopes.

Example:
    uv run python scripts/admin_compact.py --workspace-id 3b30e070-039b-47bc-ad0d-2440a2f173c5
    uv run python scripts/admin_compact.py --all --retention-days 7 --dry-run
"""

from __future__ import annotations

import argparse
import asyncio
import sys
from datetime import UTC, datetime, timedelta
from typing import Any

from dotenv import load_dotenv

from app.core.clock import Hlc, compare_hlc
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


async def _count_envelopes(conn: Any, workspace_id: str) -> int:
    row = await conn.fetchrow(
        "SELECT COUNT(*) FROM relay_envelope WHERE workspace_id = $1",
        workspace_id,
    )
    return row[0] if row else 0


async def _get_max_hlc(conn: Any, workspace_id: str) -> Hlc:
    row = await conn.fetchrow(
        """
        SELECT physical, logical
        FROM relay_envelope
        WHERE workspace_id = $1
        ORDER BY physical DESC, logical DESC
        LIMIT 1
        """,
        workspace_id,
    )
    if row is None:
        return Hlc(physical=0, logical=0)
    return Hlc(physical=row["physical"], logical=row["logical"])


async def _find_compaction_hlc(
    conn: Any, workspace_id: str, retention_days: int
) -> Hlc | None:
    """Return the highest HLC older than the retention window.

    Returns None when no envelopes are older than the retention window.
    """
    cutoff = int((datetime.now(UTC) - timedelta(days=retention_days)).timestamp() * 1000)
    row = await conn.fetchrow(
        """
        SELECT physical, logical
        FROM relay_envelope
        WHERE workspace_id = $1
          AND physical <= $2
        ORDER BY physical DESC, logical DESC
        LIMIT 1
        """,
        workspace_id,
        cutoff,
    )
    if row is None:
        return None
    return Hlc(physical=row["physical"], logical=row["logical"])


async def _compact_workspace(
    workspace_id: str,
    storage: PostgresRelayStorage,
    up_to_hlc: Hlc,
) -> dict[str, Any]:
    """Replay operations up to ``up_to_hlc`` and create a snapshot, then prune."""
    actor_id = f"system-compact-{uuidv7()}"
    store = WorkspaceStore(
        workspace_id=workspace_id,
        actor_id=actor_id,
        relay_storage=storage,
        db_path=":memory:",
        key_storage=None,
    )

    # Sync loads the latest snapshot (if any) and replays all newer envelopes,
    # so the derived database ends up at the current max HLC.
    await store.sync()

    # Create a snapshot exactly at the compaction HLC. Because sync already
    # brought the derived state past that point, the snapshot contains the
    # correct state for all operations up to and including the compaction HLC.
    snapshot_id = await store.create_snapshot(up_to_hlc=up_to_hlc)

    # Prune envelopes covered by the snapshot.
    pruned = await storage.prune_envelopes(workspace_id, up_to_hlc)

    return {
        "workspace_id": workspace_id,
        "snapshot_id": snapshot_id,
        "up_to_hlc": up_to_hlc,
        "pruned": pruned,
    }


async def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Compact relay operation logs by pruning old envelopes"
    )
    parser.add_argument(
        "--workspace-id",
        type=str,
        help="Compact a single workspace UUID",
    )
    parser.add_argument(
        "--all",
        action="store_true",
        help="Compact every workspace that has old envelopes",
    )
    parser.add_argument(
        "--retention-days",
        type=int,
        default=30,
        help="Keep envelopes from the last N days (default: 30)",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Report what would be compacted without deleting anything",
    )
    args = parser.parse_args(argv)

    if not args.workspace_id and not args.all:
        parser.error("Specify --workspace-id or --all")

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

            compacted = 0
            skipped = 0
            failed = 0
            total_pruned = 0

            for workspace_id in workspace_ids:
                envelope_count = await _count_envelopes(conn, workspace_id)
                max_hlc = await _get_max_hlc(conn, workspace_id)
                up_to_hlc = await _find_compaction_hlc(
                    conn, workspace_id, args.retention_days
                )

                if up_to_hlc is None:
                    print(
                        f"Skipping {workspace_id}: no envelopes older than "
                        f"{args.retention_days} day(s)"
                    )
                    skipped += 1
                    continue

                # Sanity check: never compact past the latest snapshot if it is
                # newer than the compaction HLC. Clients would otherwise miss data.
                snapshot_row = await conn.fetchrow(
                    """
                    SELECT hlc
                    FROM relay_snapshot
                    WHERE workspace_id = $1
                    ORDER BY (hlc->>'physical')::bigint DESC, (hlc->>'logical')::bigint DESC
                    LIMIT 1
                    """,
                    workspace_id,
                )
                if snapshot_row is not None:
                    latest_snapshot_hlc = Hlc(
                        physical=int(snapshot_row["hlc"]["physical"]),
                        logical=int(snapshot_row["hlc"]["logical"]),
                    )
                    if compare_hlc(up_to_hlc, latest_snapshot_hlc) > 0:
                        print(
                            f"Skipping {workspace_id}: compaction HLC is newer than "
                            "the latest snapshot; run snapshot generation first"
                        )
                        skipped += 1
                        continue

                print(
                    f"Processing {workspace_id} ({envelope_count:,} envelope(s), "
                    f"max HLC {max_hlc.physical}/{max_hlc.logical}, "
                    f"compact up to {up_to_hlc.physical}/{up_to_hlc.logical})",
                    flush=True,
                )

                if args.dry_run:
                    would_prune = await conn.fetchrow(
                        """
                        SELECT COUNT(*) AS count
                        FROM relay_envelope
                        WHERE workspace_id = $1
                          AND (physical, logical) <= ($2, $3)
                        """,
                        workspace_id,
                        up_to_hlc.physical,
                        up_to_hlc.logical,
                    )
                    print(
                        f"  would prune {would_prune['count']:,} envelope(s)",
                        flush=True,
                    )
                    continue

                try:
                    result = await _compact_workspace(workspace_id, storage, up_to_hlc)
                    print(
                        f"  created snapshot {result['snapshot_id']} and pruned "
                        f"{result['pruned']:,} envelope(s)",
                        flush=True,
                    )
                    compacted += 1
                    total_pruned += result["pruned"]
                except Exception as exc:
                    print(
                        f"  ERROR compacting {workspace_id}: {exc}",
                        file=sys.stderr,
                        flush=True,
                    )
                    failed += 1

            print(
                f"Done: {compacted} compacted, {skipped} skipped, {failed} failed; "
                f"{total_pruned:,} envelope(s) pruned"
            )
            return 1 if failed else 0
        finally:
            await storage.close()


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
