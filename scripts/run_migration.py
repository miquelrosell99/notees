import asyncio
import asyncpg
import os
from dotenv import load_dotenv
load_dotenv()

async def run():
    url = os.getenv('DATABASE_URL', 'postgresql://notees:change_me_password@localhost:5432/notees')
    conn = await asyncpg.connect(url)
    # Check if workspace table exists first
    row = await conn.fetchrow("SELECT COUNT(*) FROM information_schema.tables WHERE table_name = 'workspace'")
    if row[0] == 0:
        print('workspace table does not exist - run the main schema first')
        await conn.close()
        return
    with open('app/db/migrations/add_undo_log.sql') as f:
        sql = f.read()
    await conn.execute(sql)
    print('Migration applied successfully')
    row = await conn.fetchrow("SELECT COUNT(*) FROM information_schema.tables WHERE table_name = 'undo_log'")
    print(f'undo_log table exists: {row[0] > 0}')
    await conn.close()

asyncio.run(run())
