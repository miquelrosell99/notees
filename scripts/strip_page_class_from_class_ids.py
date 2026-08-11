#!/usr/bin/env python3
"""Admin script: strip the legacy page system class UUID from node.class_ids.

This is a thin wrapper around the idempotent migration in
``app.db.migrations.strip_page_class_from_class_ids``. It can be run manually
against a live deployment; the same migration also runs automatically during
``init_database``.

Usage:
    DATABASE_URL=postgresql://notees:PASSWORD@localhost:5432/notees \
        python scripts/strip_page_class_from_class_ids.py

    # Or inside the backend container:
    docker compose exec backend python scripts/strip_page_class_from_class_ids.py
"""
from __future__ import annotations

import asyncio
import os
import sys
from pathlib import Path

from dotenv import load_dotenv

sys.path.insert(0, str(Path(__file__).parent.parent))

load_dotenv()

from app.db.connection import close_pool, get_pool, init_pool  # noqa: E402
from app.db.migrations.strip_page_class_from_class_ids import run  # noqa: E402


def _require_database_url() -> None:
    if os.getenv("DATABASE_URL"):
        return
    print(
        "Error: DATABASE_URL environment variable is required.\n"
        "Example:\n"
        "  DATABASE_URL=postgresql://notees:PASSWORD@localhost:5432/notees "
        "python scripts/strip_page_class_from_class_ids.py"
    )
    sys.exit(1)


async def main() -> None:
    _require_database_url()

    await init_pool()
    try:
        pool = await get_pool()
        async with pool.acquire() as conn:
            await run(conn)
    finally:
        await close_pool()


if __name__ == "__main__":
    asyncio.run(main())
