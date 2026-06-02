#!/usr/bin/env python3
"""One-time migration: renumber all node sequences as contiguous floats.

Run inside the backend container:
    docker exec notees-backend-dev python scripts/migrate_renumber_sequences.py
"""

import asyncio
import asyncpg
import os


DATABASE_URL = os.getenv(
    "DATABASE_URL",
    "postgresql://notees:change_me_dev_password@postgres:5432/notees"
)


async def renumber_sequences() -> None:
    conn = await asyncpg.connect(DATABASE_URL)
    try:
        # Get all parents that have children
        parents = await conn.fetch(
            """
            SELECT DISTINCT parent_id
            FROM node
            WHERE parent_id IS NOT NULL
              AND active = TRUE
              AND (is_deleted = FALSE OR is_deleted IS NULL)
            ORDER BY parent_id
            """
        )

        print(f"Found {len(parents)} parents with children")

        updated = 0
        for row in parents:
            parent_id = row["parent_id"]
            children = await conn.fetch(
                """
                SELECT id
                FROM node
                WHERE parent_id = $1
                  AND active = TRUE
                  AND (is_deleted = FALSE OR is_deleted IS NULL)
                ORDER BY sequence, id
                """,
                parent_id,
            )

            for idx, child in enumerate(children):
                new_sequence = float(idx)
                await conn.execute(
                    "UPDATE node SET sequence = $1 WHERE id = $2",
                    new_sequence,
                    child["id"],
                )
                updated += 1

        print(f"Renumbered {updated} nodes")
    finally:
        await conn.close()


if __name__ == "__main__":
    asyncio.run(renumber_sequences())
