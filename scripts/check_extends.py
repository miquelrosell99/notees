"""Quick check of class extends relationships and colors."""
import asyncio
from app.db.connection import get_pool, acquire_connection

async def check():
    pool = await get_pool()
    async with acquire_connection(pool) as conn:
        rows = await conn.fetch(
            "SELECT ce.target_id, n_target.name as target_name, "
            "ce.source_id, n_source.name as source_name, n_source.color "
            "FROM class_extend ce "
            "JOIN node n_target ON n_target.id = ce.target_id "
            "JOIN node n_source ON n_source.id = ce.source_id "
            "WHERE n_target.active = TRUE AND n_source.active = TRUE "
            "ORDER BY ce.target_id LIMIT 20"
        )
        for r in rows:
            print(f"{r['target_name']} (id={r['target_id']}) extends "
                  f"{r['source_name']} (id={r['source_id']}) color={r['color']}")

asyncio.run(check())
