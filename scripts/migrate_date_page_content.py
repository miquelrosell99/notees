#!/usr/bin/env python3
"""Migrate existing daily/monthly/yearly page content to compact numeric format.

Daily pages:   YYYY-MM-DD  -> YYYYMMDD
Monthly pages: YYYY-MM    -> YYYYMM00
Yearly pages:  YYYY       -> YYYY0000

The migration replays the workspace operation log into a temporary derived
store, reads the current Yjs text state for each date UUID, and emits a
node.updateContent operation that clears and replaces the text when it does not
already match the compact format.

Example:
    uv run python scripts/migrate_date_page_content.py --workspace-id 3b30e070-039b-47bc-ad0d-2440a2f173c5 --dry-run
    uv run python scripts/migrate_date_page_content.py --workspace-id 3b30e070-039b-47bc-ad0d-2440a2f173c5
"""

from __future__ import annotations

import argparse
import asyncio
import json
import re
import subprocess
import sys
from typing import Any

from dotenv import load_dotenv

from app.core.uuid import uuidv7
from app.core.workspace_store import WorkspaceStore
from app.db.connection import get_pool, setup_jsonb_codec
from app.relay.storage import PostgresRelayStorage

DAY_UUID_RE = re.compile(r"^00000000-0000-0000-00dd-(\d{4})(\d{2})(\d{2})0000$")
MONTH_UUID_RE = re.compile(r"^00000000-0000-0000-00aa-(\d{4})(\d{2})000000$")
YEAR_UUID_RE = re.compile(r"^00000000-0000-0000-00bb-(\d{4})00000000$")


def _expected_content(node_id: str) -> str | None:
    """Return the compact content a date page should have based on its UUID."""
    m = DAY_UUID_RE.match(node_id)
    if m:
        return f"{m.group(1)}{m.group(2)}{m.group(3)}"
    m = MONTH_UUID_RE.match(node_id)
    if m:
        return f"{m.group(1)}{m.group(2)}00"
    m = YEAR_UUID_RE.match(node_id)
    if m:
        return f"{m.group(1)}0000"
    return None


def _decode_yjs_update(bytes_list: list[int]) -> str:
    """Shell out to the JS helper to decode a Yjs text update to plain text."""
    result = subprocess.run(
        ["node", "scripts/_generate_yjs_update.js", "--decode"],
        input=json.dumps(bytes_list),
        text=True,
        capture_output=True,
        check=True,
    )
    return result.stdout


def _generate_yjs_replace_update(current: str, new: str) -> list[int]:
    """Shell out to the JS helper that produces a Yjs text-replacement update."""
    result = subprocess.run(
        ["node", "scripts/_generate_yjs_update.js", "--replace"],
        input=json.dumps({"current": current, "new": new}),
        text=True,
        capture_output=True,
        check=True,
    )
    return json.loads(result.stdout)


async def _fetch_date_node_ids(conn: Any, workspace_id: str) -> list[str]:
    """Find date UUIDs that have ever been created or updated in the workspace."""
    rows = await conn.fetch(
        """
        SELECT DISTINCT node_id
        FROM relay_envelope,
             LATERAL jsonb_array_elements_text(affected_node_ids) AS node_id
        WHERE workspace_id = $1
          AND node_id ~ '^00000000-0000-0000-00(dd|aa|bb)-'
        ORDER BY node_id
        """,
        workspace_id,
    )
    return [row["node_id"] for row in rows]


async def _migrate_workspace(
    workspace_id: str,
    storage: PostgresRelayStorage,
    dry_run: bool,
) -> dict[str, Any]:
    actor_id = f"system-migrate-date-content-{uuidv7()}"
    store = WorkspaceStore(
        workspace_id=workspace_id,
        actor_id=actor_id,
        relay_storage=storage,
        db_path=":memory:",
        key_storage=None,
    )
    await store.sync()

    # Read the actual current plaintext from the derived CRDT state.
    db = await store.get_db()
    rows = db.execute(
        """
        SELECT n.id, COALESCE(cs.text_state, X'') AS text_state
        FROM node n
        LEFT JOIN crdt_state cs ON cs.node_id = n.id
        WHERE n.workspace_id = ?
          AND (
              n.id LIKE '00000000-0000-0000-00dd-%'
              OR n.id LIKE '00000000-0000-0000-00aa-%'
              OR n.id LIKE '00000000-0000-0000-00bb-%'
          )
        """,
        (workspace_id,),
    ).fetchall()

    to_migrate: list[tuple[str, str | None, str]] = []  # (node_id, old_content, new_content)
    for row in rows:
        node_id = row["id"]
        expected = _expected_content(node_id)
        if expected is None:
            continue
        text_state = row["text_state"]
        if isinstance(text_state, bytes):
            text_state = list(text_state)
        current = ""
        if text_state:
            try:
                current = _decode_yjs_update(text_state)
            except Exception:  # noqa: BLE001
                current = ""
        # Always emit a replacement update for date pages. The first migration
        # appended text to existing Yjs state on clients, producing names like
        # "2026-08-0420260804". A replace update clears all text and inserts the
        # correct compact format, fixing both server-side and client-side state.
        to_migrate.append((node_id, current, expected))

    if dry_run:
        return {
            "workspace_id": workspace_id,
            "migrated": 0,
            "would_migrate": len(to_migrate),
            "samples": [
                {"node_id": nid, "old": old, "new": new}
                for nid, old, new in to_migrate[:10]
            ],
        }

    migrated = 0
    failed = 0
    for node_id, old, new in to_migrate:
        try:
            yjs_update = _generate_yjs_replace_update(old, new)
            await store.update_text_crdt(node_id, bytes(yjs_update))
            migrated += 1
        except Exception as exc:  # noqa: BLE001
            failed += 1
            print(
                f"  Failed to migrate {node_id}: {exc}",
                file=sys.stderr,
                flush=True,
            )

    await store.close()

    return {
        "workspace_id": workspace_id,
        "migrated": migrated,
        "failed": failed,
        "would_migrate": len(to_migrate),
    }


async def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Migrate date page content to compact numeric format"
    )
    parser.add_argument(
        "--workspace-id",
        type=str,
        help="Migrate a single workspace UUID",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Show which pages would be migrated without writing operations",
    )
    args = parser.parse_args(argv)

    load_dotenv()

    pool = await get_pool()
    try:
        async with pool.acquire() as conn:
            await setup_jsonb_codec(conn)
        storage = PostgresRelayStorage(pool=pool)

        if args.workspace_id:
            workspace_ids = [args.workspace_id]
        else:
            async with pool.acquire() as conn:
                rows = await conn.fetch(
                    "SELECT DISTINCT workspace_id FROM relay_envelope ORDER BY workspace_id"
                )
            workspace_ids = [row["workspace_id"] for row in rows]

        if not workspace_ids:
            print("No workspaces with relay envelopes found.")
            return 0

        for workspace_id in workspace_ids:
            print(f"Processing workspace {workspace_id}...")
            result = await _migrate_workspace(workspace_id, storage, args.dry_run)
            if args.dry_run:
                print(f"  Would migrate {result['would_migrate']} date page(s)")
                for sample in result["samples"]:
                    print(
                        f"    {sample['node_id']}: {sample['old']!r} -> {sample['new']!r}"
                    )
            else:
                print(
                    f"  Migrated {result['migrated']}/{result['would_migrate']} date page(s), "
                    f"{result['failed']} failed"
                )
    finally:
        await pool.close()

    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
