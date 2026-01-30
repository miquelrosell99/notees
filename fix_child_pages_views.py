"""Fix existing child_pages views to use the correct query format."""
import asyncio
import asyncpg
import json

async def fix_child_pages_views():
    """Update all child_pages views to use the correct nested_group format."""
    conn = await asyncpg.connect(
        host='localhost',
        port=5432,
        database='notees',
        user='postgres',
        password='postgres'
    )
    
    try:
        # Find all child_pages views
        views = await conn.fetch("""
            SELECT id, node_id, name, view_type, query_json
            FROM node_view
            WHERE view_type = 'child_pages'
        """)
        
        print(f"Found {len(views)} child_pages views to fix")
        
        # Correct query format
        correct_query = {
            "type": "query",
            "version": "1.0",
            "scope": {
                "type": "scope",
                "scope_type": "pages"
            },
            "root_group": {
                "type": "group",
                "logic": "AND",
                "children": [
                    {
                        "type": "condition",
                        "condition_type": "parent",
                        "nested_group": {
                            "type": "group",
                            "logic": "AND",
                            "children": [
                                {
                                    "type": "condition",
                                    "condition_type": "property",
                                    "property_name": "uuid",
                                    "property_type": "text",
                                    "operator": "=",
                                    "value": "{current_node_uuid}"
                                }
                            ]
                        }
                    }
                ]
            },
            "is_system": True
        }
        
        fixed_count = 0
        for view in views:
            view_id = view['id']
            node_id = view['node_id']
            
            # Update the view with the correct query
            await conn.execute("""
                UPDATE node_view
                SET query_json = $1
                WHERE id = $2
            """, json.dumps(correct_query), view_id)
            
            fixed_count += 1
            print(f"  ✓ Fixed view {view_id} for node {node_id}")
        
        print(f"\n✅ Successfully fixed {fixed_count} child_pages views!")
        print("\nRefresh your browser to see the changes.")
        
    finally:
        await conn.close()

if __name__ == "__main__":
    asyncio.run(fix_child_pages_views())
