"""Ensure a known admin account exists for E2E tests.

Creates or updates admin@notees.local so that Playwright global setup can
authenticate and seed regular test users via the admin API.

Run against the dev database before `npm run test:e2e`:
    uv run python scripts/ensure_e2e_admin.py
"""

from __future__ import annotations

import asyncio
import os
import sys
from pathlib import Path

# Allow imports from the project root when run directly.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.config import settings
from app.db.connection import init_pool, close_pool
from app.features.auth import is_strong_admin_password
from app.features.auth.repository import PostgresUserRepository
from app.utils.password import hash_password

ADMIN_EMAIL = "admin@notees.local"


async def main() -> int:
    admin_password = settings.admin_password
    if not admin_password:
        print("ADMIN_PASSWORD is not set; cannot ensure E2E admin.", file=sys.stderr)
        return 1
    if not is_strong_admin_password(admin_password):
        print("ADMIN_PASSWORD does not meet admin complexity requirements.", file=sys.stderr)
        return 1

    pool = await init_pool()
    try:
        repo = PostgresUserRepository(pool)
        async with pool.acquire() as conn:
            row = await conn.fetchrow(
                'SELECT id FROM "user" WHERE email = $1', ADMIN_EMAIL
            )
            password_hash = hash_password(admin_password)
            if row:
                await conn.execute(
                    'UPDATE "user" SET password_hash = $1, role = \'admin\', active = TRUE WHERE id = $2',
                    password_hash,
                    row["id"],
                )
                print(f"Updated {ADMIN_EMAIL} password and admin role.")
            else:
                from app.domain.entities import generate_uuid
                from datetime import UTC, datetime

                now = datetime.now(UTC)
                await conn.execute(
                    """
                    INSERT INTO "user" (
                        uuid, email, password_hash, name, surnames,
                        profile_pic, role, active, create_date, write_date
                    )
                    VALUES ($1, $2, $3, $4, $5, $6, $7, TRUE, $8, $8)
                    """,
                    generate_uuid(),
                    ADMIN_EMAIL,
                    password_hash,
                    "E2E Admin",
                    None,
                    None,
                    "admin",
                    now,
                )
                print(f"Created {ADMIN_EMAIL} admin user.")
    finally:
        await close_pool()
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
