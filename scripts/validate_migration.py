#!/usr/bin/env python3
"""Validate migrated operations by replaying them into a SQLite derived state.

This script mirrors the dry-run path of ``scripts/migrate_to_ideal.py``: it
reads the PostgreSQL database (read-only), generates ideal operations for every
workspace, replays them into a temporary SQLite database, and prints a
reconciliation report.

Example:
    uv run python scripts/validate_migration.py

To validate a single workspace:
    uv run python scripts/validate_migration.py --workspace-id 1
"""

from __future__ import annotations

import argparse
import asyncio
import sys
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from dotenv import load_dotenv

from app.core.migration.assets import migrate_assets_for_workspace
from app.core.migration.connection import connect_postgres
from app.core.migration.links import (
    map_property_relation_targets,
    migrate_links_for_workspace,
)
from app.core.migration.nodes import (
    create_migration_context,
    migrate_nodes_for_workspace,
)
from app.core.migration.properties import migrate_properties_for_workspace
from app.core.migration.validation import (
    build_reconciliation_report,
    format_report,
)
from app.core.migration.writer import InMemoryOperationWriter
from app.core.uuid import uuidv7


async def _fetch_workspace_ids(conn: Any) -> list[int]:
    """Return all active workspace integer ids ordered by id."""
    rows = await conn.fetch(
        "SELECT id FROM workspace WHERE active = TRUE ORDER BY id"
    )
    return [row["id"] for row in rows]


async def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Validate Notees PostgreSQL → ideal operation migration"
    )
    parser.add_argument(
        "--workspace-id",
        type=int,
        help="Validate a single workspace by its legacy integer id",
    )
    parser.add_argument(
        "--keep-sqlite",
        type=str,
        help="Keep the temporary SQLite file at this path instead of deleting it",
    )
    args = parser.parse_args(argv)

    load_dotenv()

    actor_id = uuidv7()
    physical_time = int(datetime.now(UTC).timestamp() * 1000)
    conn = await connect_postgres()
    writer = InMemoryOperationWriter()
    sqlite_path: Path | None = None

    try:
        workspace_ids = (
            [args.workspace_id] if args.workspace_id else await _fetch_workspace_ids(conn)
        )
        if not workspace_ids:
            print("No active workspaces found.")
            return 0

        for ws_id in workspace_ids:
            ctx = await create_migration_context(
                conn=conn,
                workspace_int_id=ws_id,
                actor_id=actor_id,
                physical_time=physical_time,
            )
            await migrate_nodes_for_workspace(
                conn=conn,
                workspace_int_id=ws_id,
                actor_id=actor_id,
                writer=writer,
                ctx=ctx,
            )
            prop_ops = await migrate_properties_for_workspace(
                conn=conn,
                workspace_int_id=ws_id,
                ctx=ctx,
            )
            for op in prop_ops:
                writer.write_operation(op)
            await map_property_relation_targets(
                conn=conn,
                workspace_int_id=ws_id,
                ctx=ctx,
            )
            await migrate_links_for_workspace(
                conn=conn,
                workspace_int_id=ws_id,
                ctx=ctx,
                writer=writer,
            )
            await migrate_assets_for_workspace(
                conn=conn,
                workspace_int_id=ws_id,
                ctx=ctx,
                writer=writer,
                data_dir=Path.home() / ".config" / "notees-backend-dev" / "data",
                copy_files=False,
            )

        if args.keep_sqlite:
            sqlite_path = Path(args.keep_sqlite)

        report = build_reconciliation_report(
            writer.operations,
            db_path=sqlite_path,
        )
        print(format_report(report))

        # Surface non-zero orphan/duplicate counts as a non-fatal summary line.
        if report.orphan_count or report.duplicate_count:
            print(
                f"\nWarning: {report.orphan_count} orphan(s), "
                f"{report.duplicate_count} duplicate id(s) detected."
            )
    finally:
        await conn.close()
        writer.close()

    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
