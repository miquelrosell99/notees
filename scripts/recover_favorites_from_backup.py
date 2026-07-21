#!/usr/bin/env python3
"""Recover user favorites from a pre-ideal-migration PostgreSQL backup.

The migration to the operation-log architecture did not port favorites (they were
stored in `setting_user.key = 'favorites'` as legacy integer node IDs). This
script reads a pre-migration dump, maps legacy IDs to current node UUIDs, and
emits `user.favorite.add` operations into the live `relay_envelope` table so
favorites reappear in the sidebar after the next sync.

Example:
    uv run python scripts/recover_favorites_from_backup.py \
        --backup data/backups/pre-ideal-migration-20260717-230311.sql \
        --dry-run

Requires:
    - `psql` on PATH (loads the backup into a temporary database).
    - DATABASE_URL pointing to the live Notees PostgreSQL instance.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path

import asyncpg

from app.core.clock import Hlc
from app.core.operation import Operation, create_operation
from app.core.uuid import uuidv7


@dataclass
class FavoriteEntry:
    """A single recovered favorite mapped to current identifiers."""

    workspace_uuid: str
    actor_uuid: str
    node_uuid: str


async def _create_temp_database(conn: asyncpg.Connection, db_name: str) -> None:
    """Drop and recreate a temporary database."""
    exists = await conn.fetchval(
        "SELECT 1 FROM pg_database WHERE datname = $1", db_name
    )
    if exists:
        await conn.execute(f"DROP DATABASE {db_name}")
    await conn.execute(f"CREATE DATABASE {db_name}")


async def _load_backup(database_url: str, backup_path: Path) -> None:
    """Load the plain-text SQL backup into the database at database_url."""
    env = {**os.environ, "PGDATABASE": database_url}
    result = subprocess.run(
        ["psql", "-v", "ON_ERROR_STOP=1", "-f", str(backup_path), database_url],
        capture_output=True,
        text=True,
        env=env,
        check=False,
    )
    if result.returncode != 0:
        raise RuntimeError(f"psql failed: {result.stderr}\n{result.stdout}")


async def _get_max_hlc(conn: asyncpg.Connection, workspace_uuid: str) -> Hlc:
    """Return an HLC strictly greater than the newest operation in a workspace."""
    row = await conn.fetchrow(
        """
        SELECT COALESCE(MAX(physical), 0) AS physical, COALESCE(MAX(logical), 0) AS logical
        FROM relay_envelope
        WHERE workspace_id = $1
        """,
        workspace_uuid,
    )
    physical = row["physical"] if row else 0
    logical = row["logical"] if row else 0
    # Increment logical so recovered operations sort after the newest existing op.
    return Hlc(physical=physical, logical=logical + 1)


async def _resolve_user_uuid(conn: asyncpg.Connection, user_id: int) -> str | None:
    """Map legacy user integer id to current user UUID."""
    row = await conn.fetchrow(
        'SELECT uuid::text AS uuid FROM "user" WHERE id = $1 AND active = TRUE',
        user_id,
    )
    return row["uuid"] if row else None


async def _resolve_workspace_uuid(conn: asyncpg.Connection, workspace_id: int) -> str | None:
    """Map legacy workspace integer id to current workspace UUID."""
    row = await conn.fetchrow(
        "SELECT uuid::text AS uuid FROM workspace WHERE id = $1 AND active = TRUE",
        workspace_id,
    )
    return row["uuid"] if row else None


async def _collect_favorites(
    temp_conn: asyncpg.Connection,
    live_conn: asyncpg.Connection,
) -> list[FavoriteEntry]:
    """Read favorites from the backup DB and map them to current UUIDs."""
    rows = await temp_conn.fetch(
        "SELECT user_id, value FROM setting_user WHERE key = 'favorites'"
    )

    entries: list[FavoriteEntry] = []
    for row in rows:
        user_id = row["user_id"]
        value = row["value"]
        if not value:
            continue
        if isinstance(value, str):
            import json

            try:
                value = json.loads(value)
            except json.JSONDecodeError:
                continue
        if not isinstance(value, list):
            continue

        actor_uuid = await _resolve_user_uuid(live_conn, user_id)
        if not actor_uuid:
            print(f"Skipping favorites for deleted/unknown user {user_id}")
            continue

        favorite_ids = [int(x) for x in value if isinstance(x, (int, str))]
        if not favorite_ids:
            continue

        # Map legacy node IDs to (uuid, workspace_id) using the backup node table.
        node_rows = await temp_conn.fetch(
            """
            SELECT id, uuid::text AS uuid, workspace_id
            FROM node
            WHERE id = ANY($1) AND active = TRUE AND is_deleted = FALSE
            """,
            favorite_ids,
        )
        node_map = {r["id"]: (r["uuid"], r["workspace_id"]) for r in node_rows}

        for old_id in favorite_ids:
            mapping = node_map.get(old_id)
            if not mapping:
                print(f"  favorite node id {old_id} not found in backup; skipping")
                continue
            node_uuid, old_workspace_id = mapping
            workspace_uuid = await _resolve_workspace_uuid(live_conn, old_workspace_id)
            if not workspace_uuid:
                print(
                    f"  workspace {old_workspace_id} for node {node_uuid} not active; skipping"
                )
                continue
            entries.append(
                FavoriteEntry(
                    workspace_uuid=workspace_uuid,
                    actor_uuid=actor_uuid,
                    node_uuid=node_uuid,
                )
            )

    return entries


def _build_operation(entry: FavoriteEntry, hlc: Hlc) -> Operation:
    """Build a user.favorite.add operation."""
    return create_operation(
        envelope={
            "workspace_id": entry.workspace_uuid,
            "actor_id": entry.actor_uuid,
            "hlc": hlc,
            "affected_node_ids": [entry.node_uuid],
            "op_type": "user.favorite.add",
        },
        payload={"nodeId": entry.node_uuid},
    )


async def _insert_operations(
    live_conn: asyncpg.Connection,
    entries: list[FavoriteEntry],
    dry_run: bool,
) -> int:
    """Insert recovered favorite operations into relay_envelope."""
    if not entries:
        return 0

    # Group by workspace so each workspace gets a monotonic HLC sequence.
    by_workspace: dict[str, list[FavoriteEntry]] = {}
    for entry in entries:
        by_workspace.setdefault(entry.workspace_uuid, []).append(entry)

    inserted = 0
    for workspace_uuid, ws_entries in by_workspace.items():
        base_hlc = await _get_max_hlc(live_conn, workspace_uuid)
        for index, entry in enumerate(ws_entries):
            hlc = Hlc(
                physical=base_hlc.physical,
                logical=base_hlc.logical + index,
            )
            op = _build_operation(entry, hlc)
            if dry_run:
                print(
                    f"[dry-run] {entry.actor_uuid} fav {entry.node_uuid} "
                    f"in {entry.workspace_uuid} hlc={hlc.physical}/{hlc.logical}"
                )
                inserted += 1
                continue
            await live_conn.execute(
                """
                INSERT INTO relay_envelope (id, workspace_id, actor_id, physical, logical,
                                            affected_node_ids, op_type, payload, timestamp)
                VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8::jsonb, NOW())
                ON CONFLICT (id) DO NOTHING
                """,
                op.envelope.id,
                op.envelope.workspace_id,
                op.envelope.actor_id,
                op.envelope.hlc.physical,
                op.envelope.hlc.logical,
                json.dumps(op.envelope.affected_node_ids),
                op.envelope.op_type,
                json.dumps(op.payload),
            )
            inserted += 1

    return inserted


async def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Recover favorites from a pre-migration PostgreSQL backup"
    )
    parser.add_argument(
        "--backup",
        type=Path,
        default=Path("data/backups/pre-ideal-migration-20260717-230311.sql"),
        help="Path to the pre-migration plain SQL backup",
    )
    parser.add_argument(
        "--database-url",
        type=str,
        default=os.environ.get("DATABASE_URL"),
        help="Live PostgreSQL URL (defaults to DATABASE_URL env var)",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Print operations without writing to relay_envelope",
    )
    args = parser.parse_args(argv)

    if not args.database_url:
        print("ERROR: --database-url or DATABASE_URL is required", file=sys.stderr)
        return 1
    if not args.backup.exists():
        print(f"ERROR: backup not found: {args.backup}", file=sys.stderr)
        return 1

    live_dsn = args.database_url
    temp_db_name = f"notees_recovery_{uuidv7().replace('-', '_')}"

    live_conn = await asyncpg.connect(live_dsn)
    try:
        print(f"Creating temp database {temp_db_name}...")
        await _create_temp_database(live_conn, temp_db_name)
    except Exception:
        await live_conn.close()
        raise

    temp_dsn = _rewrite_dsn_database(live_dsn, temp_db_name)
    temp_conn: asyncpg.Connection | None = None
    try:
        print(f"Loading backup into {temp_db_name}...")
        await _load_backup(temp_dsn, args.backup)

        print("Mapping favorites to current UUIDs...")
        temp_conn = await asyncpg.connect(temp_dsn)
        entries = await _collect_favorites(temp_conn, live_conn)
        print(f"Mapped {len(entries)} favorite entries")

        inserted = await _insert_operations(live_conn, entries, args.dry_run)
        action = "Would insert" if args.dry_run else "Inserted"
        print(f"{action} {inserted} favorite operations into relay_envelope")
    finally:
        if temp_conn:
            await temp_conn.close()
        print(f"Dropping temp database {temp_db_name}...")
        try:
            await live_conn.execute(f"DROP DATABASE IF EXISTS {temp_db_name}")
        except Exception as e:
            print(f"Warning: failed to drop temp database: {e}", file=sys.stderr)
        await live_conn.close()

    return 0


def _rewrite_dsn_database(dsn: str, db_name: str) -> str:
    """Return a copy of dsn with the database name replaced."""
    # asyncpg DSN: postgresql://user:pass@host:port/dbname?params
    # Handle both postgres:// and postgresql:// prefixes.
    prefix = "postgresql://"
    if dsn.startswith(prefix):
        rest = dsn[len(prefix):]
    elif dsn.startswith("postgres://"):
        rest = dsn[len("postgres://"):]
        prefix = "postgres://"
    else:
        return dsn

    # rest may be user:pass@host:port/db?query
    auth_host, _, path_query = rest.partition("/")
    if not path_query:
        return f"{prefix}{auth_host}/{db_name}"

    # Preserve query params.
    db_part, _, query = path_query.partition("?")
    if query:
        return f"{prefix}{auth_host}/{db_name}?{query}"
    return f"{prefix}{auth_host}/{db_name}"


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
