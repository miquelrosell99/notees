"""Check what views exist for node 125."""
import asyncio
import asyncpg
import json

async def check_views():
    conn = await asyncpg.connect(
        host='localhost',
        port=5432,
        database='notees',
        user='postgres',
        password='postgres'
    )
    
    try:
        # Check node 125
        node = await conn.fetchrow("SELECT id, uuid, name FROM node WHERE id = 125")
        print(f"Node 125: {node['name']} ({node['uuid']})")
        print()
        
        # Get all views for node 125
        views = await conn.fetch("""
            SELECT id, name, view_type, is_default, query_json
            FROM node_view
            WHERE node_id = 125
            ORDER BY view_type
        """)
        
        print(f"Found {len(views)} views for node 125:")
        for view in views:
            print(f"\n  View ID {view['id']}: {view['name']}")
            print(f"    Type: {view['view_type']}")
            print(f"    Default: {view['is_default']}")
            if view['query_json']:
                query = json.loads(view['query_json']) if isinstance(view['query_json'], str) else view['query_json']
                print(f"    Query: {json.dumps(query, indent=6)}")
        
        # Check if there are any child nodes
        children = await conn.fetch("""
            SELECT id, uuid, name
            FROM node
            WHERE parent_id = 125
        """)
        print(f"\n\nDirect children of node 125: {len(children)}")
        for child in children:
            print(f"  - {child['name']} (ID {child['id']}, UUID {child['uuid']})")
    
    finally:
        await conn.close()

if __name__ == "__main__":
    asyncio.run(check_views())
