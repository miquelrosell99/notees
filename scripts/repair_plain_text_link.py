#!/usr/bin/env python3
"""Convert a plain-text UUID inside a node's inline content to a node_link pill.

Usage:
    uv run python scripts/repair_plain_text_link.py <node_id> <target_uuid>

Example:
    uv run python scripts/repair_plain_text_link.py \
        019fcc3c-a606-75e4-980a-5dada1630aae \
        67ceae53-136e-462c-8053-3b9c002ef38b

The script:
  1. Reads the current Yjs text CRDT state for the node from the backend
     derived SQLite.
  2. Decodes the state to the inline AST (a JSON string of paragraph nodes).
  3. Replaces the first plain-text occurrence of ``target_uuid`` with a
     ``node_link`` pill using a freshly generated link UUID.
  4. Re-encodes the AST into a Yjs text update.
  5. Appends a ``node.updateContent`` operation to the relay log so all
     clients pick up the change through normal sync.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import subprocess
import sys
from datetime import UTC, datetime
from pathlib import Path

import asyncpg

from app.core.clock import Hlc
from app.core.uuid import uuid7
from app.db.connection import get_pool

DERIVED_DB_DIR = Path(
    os.environ.get("NOTEES_DERIVED_DB_DIR", "/app/data/relay/derived")
)


def _decode_yjs_state(state_bytes: bytes) -> str:
    """Decode a full Yjs document state to the string it stores."""
    result = subprocess.run(
        ["node", "scripts/_generate_yjs_update.js", "--decode-state"],
        input=json.dumps(list(state_bytes)),
        text=True,
        capture_output=True,
        check=True,
    )
    return result.stdout


def _encode_replace_update_from_state(state_bytes: bytes, new_text: str) -> list[int]:
    """Build a Yjs update that replaces the whole document state with new text."""
    result = subprocess.run(
        ["node", "scripts/_generate_yjs_update.js", "--replace-from-state"],
        input=json.dumps({"state": list(state_bytes), "new": new_text}),
        text=True,
        capture_output=True,
        check=True,
    )
    return json.loads(result.stdout)


def _replace_text_with_link(ast: list[dict], node_id: str, target_uuid: str) -> bool:
    """Walk ``ast`` in place and replace the first plain-text UUID with a node_link."""
    changed = False
    for paragraph in ast:
        if paragraph.get("type") != "paragraph":
            continue
        new_children: list[dict] = []
        for child in paragraph.get("children", []):
            if (
                child.get("type") == "text"
                and child.get("text") == target_uuid
                and not changed
            ):
                link_uuid = str(uuid7())
                new_children.append({
                    "type": "node_link",
                    "link_id": f"{target_uuid}:{link_uuid}",
                    "ref_type": "node",
                })
                changed = True
            else:
                new_children.append(child)
        paragraph["children"] = new_children
    return changed


async def _get_workspace_id_for_node(
    pg_conn: asyncpg.Connection, node_id: str
) -> str | None:
    """Return the workspace_id from the node's create or latest update envelope."""
    row = await pg_conn.fetchrow(
        """
        SELECT workspace_id
        FROM relay_envelope
        WHERE op_type IN ('node.create', 'node.updateContent')
          AND payload->>'nodeId' = $1
        ORDER BY physical DESC, logical DESC, id DESC
        LIMIT 1
        """,
        node_id,
    )
    return row["workspace_id"] if row else None


async def _get_node_context(derived_path: Path, node_id: str) -> dict | None:
    """Return workspace_id, actor_id and current CRDT state for ``node_id``."""
    import sqlite3

    conn = sqlite3.connect(derived_path)
    conn.row_factory = sqlite3.Row
    try:
        row = conn.execute(
            """
            SELECT workspace_id, updated_by, created_by,
                   hlc_physical, hlc_logical
            FROM node
            WHERE id = ?
            """,
            (node_id,),
        ).fetchone()
    finally:
        conn.close()

    if row is None:
        return None

    actor_id = row["updated_by"] or row["created_by"]
    return {
        "workspace_id": row["workspace_id"],
        "actor_id": actor_id,
        "hlc_physical": row["hlc_physical"],
        "hlc_logical": row["hlc_logical"],
    }


async def _next_hlc(conn: asyncpg.Connection, workspace_id: str) -> Hlc:
    """Return an HLC strictly greater than any existing envelope in the workspace."""
    row = await conn.fetchrow(
        """
        SELECT MAX(physical) AS physical
        FROM relay_envelope
        WHERE workspace_id = $1
        """,
        workspace_id,
    )
    physical = row["physical"] or 0
    return Hlc(physical=physical + 1, logical=0)


async def run(node_id: str, target_uuid: str) -> None:
    pool = await get_pool()
    async with pool.acquire() as pg_conn:
        workspace_id = await _get_workspace_id_for_node(pg_conn, node_id)
        if workspace_id is None:
            print(f"Node {node_id} not found in relay log", file=sys.stderr)
            sys.exit(1)

        derived_path = DERIVED_DB_DIR / f"{workspace_id}.db"
        context = await _get_node_context(derived_path, node_id)
        if context is None:
            print(f"Node {node_id} not found in derived state", file=sys.stderr)
            sys.exit(1)

        actor_id = context["actor_id"]
        if not actor_id:
            actor_id = "00000000-0000-0000-0000-000000000000"

        import sqlite3

        sqlite_conn = sqlite3.connect(derived_path)
        sqlite_conn.row_factory = sqlite3.Row
        try:
            crdt_row = sqlite_conn.execute(
                "SELECT text_state FROM crdt_state WHERE node_id = ?", (node_id,)
            ).fetchone()
        finally:
            sqlite_conn.close()

        if not crdt_row or not crdt_row["text_state"]:
            print(f"No text CRDT state for node {node_id}", file=sys.stderr)
            sys.exit(1)

        current_json = _decode_yjs_state(crdt_row["text_state"])
        try:
            ast = json.loads(current_json)
        except json.JSONDecodeError as exc:
            print(f"Failed to parse inline AST: {exc}", file=sys.stderr)
            sys.exit(1)

        if not _replace_text_with_link(ast, node_id, target_uuid):
            print(
                f"Plain-text UUID {target_uuid} not found in node {node_id} content",
                file=sys.stderr,
            )
            sys.exit(1)

        new_json = json.dumps(ast, separators=(",", ":"), ensure_ascii=False)
        text_update = _encode_replace_update_from_state(
            crdt_row["text_state"], new_json
        )

        hlc = await _next_hlc(pg_conn, workspace_id)
        op_id = str(uuid7())
        timestamp = datetime.now(UTC)

        await pg_conn.execute(
            """
            INSERT INTO relay_envelope (
                id, workspace_id, actor_id, physical, logical,
                affected_node_ids, op_type, payload, timestamp
            ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9)
            """,
            op_id,
            workspace_id,
            actor_id,
            hlc.physical,
            hlc.logical,
            [node_id],
            "node.updateContent",
            {
                "nodeId": node_id,
                "textUpdate": text_update,
            },
            timestamp,
        )

    print(f"Appended node.updateContent {op_id} for node {node_id}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="Convert a plain-text UUID to a node_link pill."
    )
    parser.add_argument("node_id", help="Node containing the plain-text UUID")
    parser.add_argument("target_uuid", help="UUID that should become a node_link target")
    args = parser.parse_args()
    asyncio.run(run(args.node_id, args.target_uuid))
