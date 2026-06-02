"""Benchmark recursive CTE performance for tree queries.

Phase 0.3: Data Model Hardening — measure get_descendants() performance
at various depths and node counts to decide if closure table is needed.

Usage (inside backend container):
    python -m app.db.benchmark_cte
"""

import asyncio
import time

import asyncpg

from app.db.connection import get_database_url


async def setup_benchmark_data(conn: asyncpg.Connection, depth: int, nodes_per_level: int) -> int:
    """Create a deep tree: root -> child -> child ... with siblings at each level.

    Returns the root node ID.
    """
    # Create a root page
    root = await conn.fetchrow(
        """
        INSERT INTO node (uuid, workspace_id, name, is_page, active, is_deleted, sequence)
        VALUES (uuid_generate_v4(), 1, 'benchmark-root', TRUE, TRUE, FALSE, 0.0)
        RETURNING id
        """
    )
    root_id = root["id"]

    parent_id = root_id
    for level in range(1, depth + 1):
        # Insert nodes at this level
        for sibling in range(nodes_per_level):
            await conn.execute(
                """
                INSERT INTO node (uuid, workspace_id, name, parent_id, page_id, active, is_deleted, sequence)
                VALUES (uuid_generate_v4(), 1, $1, $2, $3, TRUE, FALSE, $4)
                """,
                f"level-{level}-sibling-{sibling}",
                parent_id,
                root_id,
                float(sibling),
            )
        # For the next level, use the first sibling as the single chain
        first = await conn.fetchrow(
            "SELECT id FROM node WHERE parent_id = $1 ORDER BY sequence LIMIT 1",
            parent_id,
        )
        parent_id = first["id"]

    return root_id


async def run_benchmark():
    pool = await asyncpg.create_pool(get_database_url())

    async with pool.acquire() as conn:
        # Ensure test workspace exists
        ws = await conn.fetchrow(
            "SELECT id FROM workspace WHERE id = 1"
        )
        if not ws:
            await conn.execute(
                """
                INSERT INTO workspace (id, uuid, name, create_date, write_date)
                VALUES (1, uuid_generate_v4(), 'benchmark-ws', NOW(), NOW())
                """
            )

        # Clean up previous benchmark data
        await conn.execute("DELETE FROM node WHERE name LIKE 'benchmark-%' AND workspace_id = 1")

        scenarios = [
            (1, 100),      # 1 level deep, 100 siblings
            (5, 10),       # 5 levels, 10 siblings each
            (10, 5),       # 10 levels, 5 siblings each
            (10, 10),      # 10 levels, 10 siblings each
            (20, 3),       # 20 levels, 3 siblings each
            (50, 2),       # 50 levels, 2 siblings each
            (100, 1),      # 100 levels deep, linear chain
            (5, 100),      # 5 levels, 100 siblings each = ~500 nodes
            (10, 50),      # 10 levels, 50 siblings each = ~500 nodes
            (10, 100),     # 10 levels, 100 siblings each = ~1k nodes
            (20, 50),      # 20 levels, 50 siblings each = ~1k nodes
        ]

        print("Benchmarking recursive CTE get_descendants()")
        print("=" * 60)
        print(f"{'Depth':>8} {'Siblings':>10} {'Total Nodes':>12} {'Time (ms)':>12} {'Notes'}")
        print("-" * 60)

        for depth, siblings in scenarios:
            root_id = await setup_benchmark_data(conn, depth, siblings)

            # Count total nodes in tree
            total = await conn.fetchval(
                """
                WITH RECURSIVE descendants AS (
                    SELECT id FROM node WHERE id = $1
                    UNION ALL
                    SELECT n.id FROM node n JOIN descendants d ON n.parent_id = d.id
                )
                SELECT COUNT(*) FROM descendants
                """,
                root_id,
            )

            # Warmup
            for _ in range(3):
                await conn.fetch(
                    """
                    WITH RECURSIVE descendants AS (
                        SELECT id, 0 AS depth FROM node WHERE id = $1 AND workspace_id = 1 AND active = TRUE AND is_deleted = FALSE AND is_comment = FALSE
                        UNION ALL
                        SELECT n.id, d.depth + 1 FROM node n
                        INNER JOIN descendants d ON n.parent_id = d.id
                        WHERE n.workspace_id = 1 AND n.active = TRUE AND n.is_deleted = FALSE AND n.is_comment = FALSE
                    )
                    SELECT id FROM descendants
                    """,
                    root_id,
                )

            # Benchmark
            times = []
            for _ in range(10):
                start = time.perf_counter()
                await conn.fetch(
                    """
                    WITH RECURSIVE descendants AS (
                        SELECT id, 0 AS depth FROM node WHERE id = $1 AND workspace_id = 1 AND active = TRUE AND is_deleted = FALSE AND is_comment = FALSE
                        UNION ALL
                        SELECT n.id, d.depth + 1 FROM node n
                        INNER JOIN descendants d ON n.parent_id = d.id
                        WHERE n.workspace_id = 1 AND n.active = TRUE AND n.is_deleted = FALSE AND n.is_comment = FALSE
                    )
                    SELECT id FROM descendants
                    """,
                    root_id,
                )
                elapsed = (time.perf_counter() - start) * 1000
                times.append(elapsed)

            avg_time = sum(times) / len(times)
            note = ""
            if avg_time > 100:
                note = "SLOW >100ms"
            elif avg_time > 50:
                note = "WARNING >50ms"

            print(f"{depth:>8} {siblings:>10} {total:>12} {avg_time:>11.2f}  {note}")

        # Cleanup
        await conn.execute("DELETE FROM node WHERE name LIKE 'benchmark-%' AND workspace_id = 1")

    await pool.close()


if __name__ == "__main__":
    asyncio.run(run_benchmark())
