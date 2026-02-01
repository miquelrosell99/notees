import asyncio
import asyncpg
import json

async def check():
    conn = await asyncpg.connect('postgresql://notees:change_me_dev_password@localhost:5432/notees')
    
    # Check views for node 124
    rows = await conn.fetch('''
        SELECT id, node_id, view_type, name, is_default, query_ast, active 
        FROM node_views 
        WHERE node_id = 124 
        ORDER BY view_type, order_index
    ''')
    
    print('Views for node 124 (year page):')
    for r in rows:
        print(f'  ID={r["id"]}, type={r["view_type"]}, name={r["name"]}, default={r["is_default"]}, active={r["active"]}')
        if r['query_ast']:
            print(f'    AST: {json.dumps(r["query_ast"], indent=2)}')
        print()
    
    await conn.close()

asyncio.run(check())
