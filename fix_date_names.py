"""Fix existing date nodes that have plain text names instead of AST JSON."""
import asyncpg
import asyncio
import os
import json

def build_text_ast(text: str) -> str:
    """Build an AST document for plain text."""
    ast = [{"type": "paragraph", "children": [{"type": "text", "text": text}]}]
    return json.dumps(ast)

async def fix_dates():
    # Parse DATABASE_URL or use defaults
    db_url = os.getenv('DATABASE_URL', 'postgresql://notees:change_me_dev_password@localhost:5432/notees')
    conn = await asyncpg.connect(db_url)
    
    # Find all date nodes with plain text names (not starting with '[')
    rows = await conn.fetch('''
        SELECT id, uuid, name, is_day, is_month, is_year 
        FROM node 
        WHERE (is_day = TRUE OR is_month = TRUE OR is_year = TRUE)
        AND (name IS NULL OR name NOT LIKE '[%')
    ''')
    
    print(f'Found {len(rows)} date nodes with plain text names')
    
    for row in rows:
        node_id = row['id']
        old_name = row['name'] or ''
        
        # Build proper AST JSON
        ast_name = build_text_ast(old_name)
        
        await conn.execute('UPDATE node SET name = $1 WHERE id = $2', ast_name, node_id)
        print(f'  Fixed node {node_id}: "{old_name}" -> AST')
    
    await conn.close()
    print('Done!')

if __name__ == '__main__':
    asyncio.run(fix_dates())
