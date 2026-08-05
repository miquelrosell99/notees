#!/usr/bin/env python3
"""
Fix date page content in the relay operation log.

Date pages should store compact numeric content:
  - day:   YYYYMMDD
  - month: YYYYMM00
  - year:  YYYY0000

Earlier migrations wrote extended, doubled, or paragraph-style content. This
script inserts a corrected ``node.updateContent`` operation carrying a direct
content AST per affected date page. The content AST wins via last-write-wins
ordering, so every client pulls the fix through normal sync.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import re
import sys
from typing import Any

from app.core.workspace_store import WorkspaceStore
from app.db.connection import get_pool, setup_jsonb_codec
from app.relay.storage import PostgresRelayStorage

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


def _ast_text(content: Any) -> str:
    """Best-effort extraction of plain text from a node content AST."""
    if isinstance(content, str):
        try:
            content = json.loads(content)
        except json.JSONDecodeError:
            return content
    if not isinstance(content, list):
        return ""
    parts: list[str] = []
    for item in content:
        if isinstance(item, dict):
            text = item.get("text")
            if isinstance(text, str):
                parts.append(text)
            children = item.get("children")
            if isinstance(children, list):
                parts.append(_ast_text(children))
    return "".join(parts)


async def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Fix date page content in the relay operation log"
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Show which pages would be fixed without writing operations",
    )
    args = parser.parse_args(argv)

    pool = await get_pool()
    try:
        async with pool.acquire() as conn:
            await setup_jsonb_codec(conn)
        storage = PostgresRelayStorage(pool=pool)
        store = WorkspaceStore(
            workspace_id=WORKSPACE_UUID,
            actor_id=ACTOR_UUID,
            relay_storage=storage,
            db_path=":memory:",
            key_storage=None,
        )

        print("Syncing workspace derived state...")
        await store.sync()
        print("Workspace synced")

        db = await store.get_db()
        rows = db.execute(
            """
            SELECT id, content
            FROM node
            WHERE workspace_id = ?
              AND (
                  id LIKE '00000000-0000-0000-00dd-%'
                  OR id LIKE '00000000-0000-0000-00aa-%'
                  OR id LIKE '00000000-0000-0000-00bb-%'
              )
            """,
            (WORKSPACE_UUID,),
        ).fetchall()

        to_fix: list[tuple[str, str, str]] = []
        for row in rows:
            node_id = row["id"]
            expected = expected_content(node_id)
            if expected is None:
                continue
            current = _ast_text(row["content"])
            if current != expected:
                to_fix.append((node_id, current, expected))

        print(f"{len(to_fix)} date page(s) need content correction")
        if not to_fix:
            return 0

        if args.dry_run:
            for node_id, current, expected in to_fix[:10]:
                print(f"  {node_id}: {current!r} -> {expected!r}")
            return 0

        fixed = 0
        failed = 0
        for node_id, _current, expected in to_fix:
            try:
                op = store._build_operation(
                    "node.updateContent",
                    {
                        "nodeId": node_id,
                        "content": [{"type": "text", "text": expected}],
                    },
                    [node_id],
                )
                await store.apply(op)
                fixed += 1
            except Exception as exc:  # noqa: BLE001
                failed += 1
                print(f"  Failed to fix {node_id}: {exc}", file=sys.stderr, flush=True)

        print(f"Fixed {fixed}/{len(to_fix)} date page(s), {failed} failed")
        return 0 if failed == 0 else 1
    finally:
        await store.close()
        await pool.close()


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
