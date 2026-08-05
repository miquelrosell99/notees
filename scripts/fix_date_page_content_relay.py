#!/usr/bin/env python3
"""
Fix date page content in the relay operation log.

Date pages should store compact numeric content:
  - day:   YYYYMMDD
  - month: YYYYMM00
  - year:  YYYY0000

Earlier migrations wrote extended or doubled content. This script inserts a
single corrected node.updateContent operation per affected date page so every
client pulls the fix through normal sync.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import subprocess
import sys
from datetime import UTC, datetime
from pathlib import Path

import asyncpg

WORKSPACE_UUID = "3b30e070-039b-47bc-ad0d-2440a2f173c5"
ACTOR_UUID = "00000000-0000-0000-0000-000000000000"

DATE_UUID_RE = re.compile(
    r"^00000000-0000-0000-00(?P<kind>dd|aa|bb)-(?P<year>\d{4})(?P<month>\d{2})(?P<day>\d{2})0000$"
)


def expected_content(node_id: str) -> str | None:
    m = DATE_UUID_RE.match(node_id)
    if not m:
        return None
    kind = m.group("kind")
    year = m.group("year")
    month = m.group("month")
    day = m.group("day")
    if kind == "dd":
        return f"{year}{month}{day}"
    if kind == "aa":
        return f"{year}{month}00"
    if kind == "bb":
        return f"{year}0000"
    return None


def node_is_date(node_id: str) -> bool:
    return DATE_UUID_RE.match(node_id) is not None


async def get_db_pool() -> asyncpg.Pool:
    dsn = os.environ.get("DATABASE_URL")
    if dsn:
        return await asyncpg.create_pool(dsn)
    # Compose-provided defaults (avoid DSN quoting issues with special chars).
    return await asyncpg.create_pool(
        user=os.environ.get("POSTGRES_USER", "notees"),
        password=os.environ.get("POSTGRES_PASSWORD", "notees"),
        host=os.environ.get("POSTGRES_HOST", "db"),
        port=int(os.environ.get("POSTGRES_PORT", "5432")),
        database=os.environ.get("POSTGRES_DB", "notees"),
    )


async def load_latest_text_updates(
    pool: asyncpg.Pool, workspace_id: str
) -> dict[str, list[int]]:
    """Return the latest textUpdate payload byte array for each date page."""
    rows = await pool.fetch(
        """
        SELECT DISTINCT ON (payload->>'nodeId')
            payload->>'nodeId' AS node_id,
            payload->'textUpdate' AS text_update
        FROM relay_envelope
        WHERE workspace_id = $1
          AND op_type = 'node.updateContent'
          AND payload ? 'textUpdate'
          AND payload->>'nodeId' ~ '^00000000-0000-0000-00(dd|aa|bb)-'
        ORDER BY payload->>'nodeId', physical DESC, logical DESC, id DESC
        """,
        workspace_id,
    )
    result: dict[str, list[int]] = {}
    for row in rows:
        node_id = row["node_id"]
        text_update = row["text_update"]
        if node_id and text_update:
            # asyncpg may return JSON arrays as strings; parse them back.
            if isinstance(text_update, str):
                text_update = json.loads(text_update)
            result[node_id] = text_update
    return result


def decode_updates_batch(updates: list[list[int]]) -> list[str]:
    if not updates:
        return []
    input_json = json.dumps(updates)
    script = Path(__file__).with_name("_generate_yjs_update.js")
    proc = subprocess.run(
        ["node", str(script), "--decode-batch"],
        input=input_json,
        capture_output=True,
        text=True,
        check=True,
    )
    return json.loads(proc.stdout)


def encode_updates_batch(pairs: list[tuple[str, str]]) -> list[list[int]]:
    if not pairs:
        return []
    input_json = json.dumps([{"current": c, "new": n} for c, n in pairs])
    script = Path(__file__).with_name("_generate_yjs_update.js")
    proc = subprocess.run(
        ["node", str(script), "--encode-batch"],
        input=input_json,
        capture_output=True,
        text=True,
        check=True,
    )
    return json.loads(proc.stdout)


async def get_max_hlc(pool: asyncpg.Pool, workspace_id: str) -> dict[str, int]:
    row = await pool.fetchrow(
        "SELECT COALESCE(MAX(physical), 0) AS physical, COALESCE(MAX(logical), 0) AS logical "
        "FROM relay_envelope WHERE workspace_id = $1",
        workspace_id,
    )
    assert row is not None
    return {"physical": int(row["physical"]), "logical": int(row["logical"])}


async def insert_fix_envelopes(
    pool: asyncpg.Pool,
    workspace_id: str,
    fixes: list[tuple[str, list[int]]],
    base_hlc: dict[str, int],
) -> int:
    if not fixes:
        return 0

    physical = base_hlc["physical"]
    # Use a monotonically increasing logical counter well above the current max.
    logical_start = base_hlc["logical"] + 1000
    timestamp = datetime.now(UTC)

    rows: list[tuple[str, str, str, int, int, str, str, str, datetime]] = []
    for idx, (node_id, text_update) in enumerate(fixes):
        envelope_id = f"fix-date-content-{workspace_id}-{node_id}"
        payload = json.dumps({"nodeId": node_id, "textUpdate": text_update})
        affected = json.dumps([node_id])
        rows.append(
            (
                envelope_id,
                workspace_id,
                ACTOR_UUID,
                physical,
                logical_start + idx,
                affected,
                "node.updateContent",
                payload,
                timestamp,
            )
        )

    async with pool.acquire() as conn, conn.transaction():
            await conn.executemany(
                """
                INSERT INTO relay_envelope (
                    id, workspace_id, actor_id, physical, logical,
                    affected_node_ids, op_type, payload, timestamp
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
                ON CONFLICT (id) DO NOTHING
                """,
                rows,
            )
    return len(rows)


async def main() -> int:
    pool = await get_db_pool()
    try:
        print("Loading latest date page text updates...")
        updates = await load_latest_text_updates(pool, WORKSPACE_UUID)
        print(f"Found {len(updates)} date pages with text updates")

        # Filter to pages whose current content is not the compact form.
        node_ids = list(updates.keys())
        decoded = decode_updates_batch(list(updates.values()))

        to_fix: list[tuple[str, str, str]] = []
        for node_id, current in zip(node_ids, decoded, strict=True):
            expected = expected_content(node_id)
            if expected is None:
                continue
            if current != expected:
                to_fix.append((node_id, current, expected))

        print(f"{len(to_fix)} date pages need content correction")
        if not to_fix:
            return 0

        print("Generating replacement Yjs updates...")
        new_updates = encode_updates_batch([(c, e) for _, c, e in to_fix])

        fixes = list(zip([node_id for node_id, _, _ in to_fix], new_updates, strict=True))

        base_hlc = await get_max_hlc(pool, WORKSPACE_UUID)
        inserted = await insert_fix_envelopes(pool, WORKSPACE_UUID, fixes, base_hlc)
        print(f"Inserted {inserted} correction envelopes")
        return 0
    finally:
        await pool.close()


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
