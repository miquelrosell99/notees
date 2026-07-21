#!/usr/bin/env python3
"""One-time import of user favorites from the pre-ideal PostgreSQL dump.

The legacy app stored favorites in ``setting_user`` with key ``'favorites'`` as a
JSON array of legacy ``node.id`` integers. This script parses the pre-ideal dump,
maps those integer IDs to current node UUIDs and workspaces, and emits
``user.favorite.add`` operations into the relay log.

Example:
    uv run python scripts/migrate_favorites_from_dump.py \
        --dump data/backups/pre-ideal-migration-20260717-230311.sql
"""

from __future__ import annotations

import argparse
import asyncio
import json
import re
import sys
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from dotenv import load_dotenv

from app.core.clock import Hlc
from app.core.operation import Operation, create_operation
from app.core.uuid import uuidv7
from app.db.connection import get_pool, setup_jsonb_codec
from app.relay.models import EncryptedEnvelope
from app.relay.storage import PostgresRelayStorage

_COPY_RE = re.compile(
    r"COPY public\.(?P<table>\w+) \((?P<cols>[^)]+)\) FROM stdin;\n(?P<rows>.*?)\\\.",
    re.DOTALL,
)


def _parse_dump(dump_path: Path) -> tuple[dict[int, str], dict[int, str]]:
    """Return (node_id_to_uuid, node_id_to_workspace_id) from the dump."""
    sql = dump_path.read_text()
    tables: dict[str, list[tuple[int, ...]]] = {}
    for match in _COPY_RE.finditer(sql):
        table = match.group("table")
        cols = [c.strip() for c in match.group("cols").split(",")]
        rows: list[tuple[int, ...]] = []
        for line in match.group("rows").strip().split("\n"):
            parts = line.split("\t")
            if table == "node":
                row_id = int(parts[cols.index("id")])
                uuid = parts[cols.index("uuid")]
                workspace_id = int(parts[cols.index("workspace_id")])
                rows.append((row_id, uuid, workspace_id))
            elif table == "setting_user":
                user_id = int(parts[cols.index("user_id")])
                key = parts[cols.index("key")]
                value = parts[cols.index("value")]
                rows.append((user_id, key, value))
        tables[table] = rows

    node_id_to_uuid: dict[int, str] = {}
    node_id_to_workspace_int: dict[int, int] = {}
    for row_id, uuid, workspace_id in tables.get("node", []):
        node_id_to_uuid[row_id] = uuid
        node_id_to_workspace_int[row_id] = workspace_id

    favorites: dict[int, list[int]] = {}
    for user_id, key, value in tables.get("setting_user", []):
        if key != "favorites":
            continue
        try:
            favorites[user_id] = json.loads(value)
        except json.JSONDecodeError:
            print(f"Warning: invalid favorites JSON for user {user_id}: {value}", file=sys.stderr)

    return node_id_to_uuid, node_id_to_workspace_int, favorites


async def _load_current_mappings(conn: Any) -> tuple[dict[int, str], dict[int, str]]:
    """Return (workspace_int_to_uuid, user_int_to_uuid) from the current DB."""
    workspace_rows = await conn.fetch("SELECT id, uuid::text FROM workspace")
    workspace_map = {row["id"]: row["uuid"] for row in workspace_rows}

    user_rows = await conn.fetch('SELECT id, uuid::text FROM "user"')
    user_map = {row["id"]: row["uuid"] for row in user_rows}

    return workspace_map, user_map


def _hlc_now() -> Hlc:
    return Hlc(physical=int(datetime.now(UTC).timestamp() * 1000), logical=0)


def _to_envelope(operation: Operation) -> EncryptedEnvelope:
    return EncryptedEnvelope(
        id=operation.envelope.id,
        workspace_id=operation.envelope.workspace_id,
        actor_id=operation.envelope.actor_id,
        hlc=operation.envelope.hlc,
        affected_node_ids=operation.envelope.affected_node_ids,
        op_type=operation.envelope.op_type,
        payload=operation.payload,
        timestamp=operation.envelope.timestamp,
    )


async def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Import user favorites from the pre-ideal PostgreSQL dump"
    )
    parser.add_argument(
        "--dump",
        type=str,
        default="data/backups/pre-ideal-migration-20260717-230311.sql",
        help="Path to the pre-ideal PostgreSQL dump",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Print what would be created without writing operations",
    )
    args = parser.parse_args(argv)

    load_dotenv()

    dump_path = Path(args.dump)
    if not dump_path.exists():
        print(f"Dump not found: {dump_path}", file=sys.stderr)
        return 1

    node_id_to_uuid, node_id_to_workspace_int, favorites = _parse_dump(dump_path)
    print(f"Parsed {len(node_id_to_uuid)} node mappings and {len(favorites)} favorite entries")

    pool = await get_pool()
    async with pool.acquire() as conn:
        await setup_jsonb_codec(conn)
        workspace_map, user_map = await _load_current_mappings(conn)

        operations: list[EncryptedEnvelope] = []
        skipped = 0
        for user_int_id, favorite_ids in favorites.items():
            actor_id = user_map.get(user_int_id)
            if actor_id is None:
                print(f"Skipping user {user_int_id}: not found in current DB")
                skipped += 1
                continue

            for legacy_node_id in favorite_ids:
                node_uuid = node_id_to_uuid.get(legacy_node_id)
                if node_uuid is None:
                    print(
                        f"Skipping favorite {legacy_node_id} for user {user_int_id}: "
                        "node not found in dump"
                    )
                    skipped += 1
                    continue

                workspace_int_id = node_id_to_workspace_int.get(legacy_node_id)
                workspace_uuid = workspace_map.get(workspace_int_id)
                if workspace_uuid is None:
                    print(
                        f"Skipping favorite {legacy_node_id} for user {user_int_id}: "
                        f"workspace {workspace_int_id} not found"
                    )
                    skipped += 1
                    continue

                op = create_operation(
                    envelope={
                        "id": uuidv7(),
                        "workspace_id": workspace_uuid,
                        "actor_id": actor_id,
                        "hlc": _hlc_now(),
                        "affected_node_ids": [node_uuid],
                        "op_type": "user.favorite.add",
                    },
                    payload={"nodeId": node_uuid},
                )
                operations.append(_to_envelope(op))

        print(f"Would emit {len(operations)} favorite operation(s); {skipped} skipped")

        if args.dry_run:
            return 0

        storage = PostgresRelayStorage(pool=pool)
        try:
            for envelope in operations:
                await storage.save_envelope(envelope)
            print(f"Saved {len(operations)} favorite operation(s)")
        finally:
            await storage.close()

    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
