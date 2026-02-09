"""Check date nodes in the database."""
import asyncpg
import asyncio


async def check():
    conn = await asyncpg.connect('postgresql://postgres:postgres@localhost:5432/notees')
    rows = await conn.fetch('''
        SELECT id, uuid, name, is_day, is_month, is_year 
        FROM node 
        WHERE is_day = true OR is_month = true OR is_year = true 
        LIMIT 10
    ''')
    print('Date nodes:')
    for r in rows:
        print(f"id={r['id']}, uuid={r['uuid']}, name={repr(r['name'])}, is_day={r['is_day']}, is_month={r['is_month']}, is_year={r['is_year']}")
    await conn.close()


if __name__ == '__main__':
    asyncio.run(check())
