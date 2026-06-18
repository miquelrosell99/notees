#!/usr/bin/env python3
"""Promote a user to admin.

Usage:
    python scripts/promote_user_to_admin.py <email>

Example:
    python scripts/promote_user_to_admin.py user@example.com
"""
import asyncio
import sys

import asyncpg
from dotenv import load_dotenv

load_dotenv()


async def promote(email: str) -> None:
    import os

    url = os.getenv("DATABASE_URL")
    if not url:
        print(
            "Error: DATABASE_URL environment variable is required.\n"
            "Example:\n"
            "  DATABASE_URL=postgresql://notees:YOUR_PASSWORD@localhost:5432/notees "
            "python scripts/promote_user_to_admin.py user@example.com"
        )
        sys.exit(1)
    conn = await asyncpg.connect(url)

    user = await conn.fetchrow('SELECT id, email, role FROM "user" WHERE email = $1', email)
    if not user:
        print(f"User '{email}' not found.")
        await conn.close()
        sys.exit(1)

    if user["role"] == "admin":
        print(f"User '{email}' is already an admin.")
        await conn.close()
        return

    await conn.execute(
        'UPDATE "user" SET role = \'admin\', write_date = NOW() WHERE id = $1',
        user["id"],
    )
    print(f"User '{email}' (id={user['id']}) has been promoted to admin.")
    await conn.close()


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python scripts/promote_user_to_admin.py <email>")
        sys.exit(1)

    asyncio.run(promote(sys.argv[1]))
