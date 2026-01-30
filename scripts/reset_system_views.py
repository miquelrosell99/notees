"""
Reset System Views Script

Resets all system views (linked_references, child_pages, classed_nodes) to their default
conditions with proper scope settings. Useful for migrating to new query structure.

Usage:
    # Run from outside Docker (connect to exposed port)
    DATABASE_URL=postgresql://notees:change_me_dev_password@localhost:5432/notees python scripts/reset_system_views.py
    
    # Or run inside backend container
    docker compose exec backend python scripts/reset_system_views.py
"""
import asyncio
import json
import os
from pathlib import Path
import sys

# Add parent directory to path
sys.path.insert(0, str(Path(__file__).parent.parent))

# Set DATABASE_URL if not already set (for running outside Docker)
if not os.getenv('DATABASE_URL'):
    os.environ['DATABASE_URL'] = 'postgresql://notees:change_me_dev_password@localhost:5433/notees'

from app.db.connection import get_connection


async def reset_system_views():
    """Reset all system views to default conditions."""
    
    # Default query structures for each view type
    # Note: All blocks are marked as system blocks (isSystemNode: true)
    default_queries = {
        'linked_references': {
            'type': 'AND_CONTAINER',
            'blocks': [
                {
                    'type': 'REFERENCE',
                    'value': '{current_node_uuid}',
                    'isSystemNode': True
                }
            ],
            'scope': {
                'scope_type': 'all'
            }
        },
        'child_pages': {
            'type': 'AND_CONTAINER',
            'blocks': [
                {
                    'type': 'PROPERTY',
                    'property_name': 'parent_uuid',
                    'property_type': 'text',
                    'operator': '=',
                    'value': '{current_node_uuid}',
                    'isSystemNode': True
                }
            ],
            'scope': {
                'scope_type': 'pages'
            }
        },
        'classed_nodes': {
            'type': 'AND_CONTAINER',
            'blocks': [
                {
                    'type': 'CLASS',
                    'value': '{current_node_uuid}',
                    'operator': 'contains',
                    'isSystemNode': True
                }
            ],
            'scope': {
                'scope_type': 'all'
            }
        }
    }
    
    async with get_connection() as conn:
        # Get all system views with node names
        views = await conn.fetch("""
            SELECT nv.id, nv.node_id, nv.view_type, nv.name, nv.query_json, n.name as node_name
            FROM node_view nv
            JOIN node n ON n.id = nv.node_id
            WHERE nv.view_type IN ('linked_references', 'child_pages', 'classed_nodes')
            AND nv.is_default = true
            ORDER BY nv.node_id, nv.view_type
        """)
        
        if not views:
            print("No system views found.")
            return
        
        print(f"Found {len(views)} system views to reset.\n")
        
        updated_count = 0
        for view in views:
            view_id = view['id']
            node_id = view['node_id']
            view_type = view['view_type']
            name = view['name']
            node_name = view['node_name']
            
            # Get default query for this view type
            default_query = default_queries.get(view_type)
            if not default_query:
                print(f"  ⚠ Skipping view {view_id} ({view_type}): No default query defined")
                continue
            
            # Update the view
            new_query_json = json.dumps(default_query)
            await conn.execute("""
                UPDATE node_view
                SET query_json = $1
                WHERE id = $2
            """, new_query_json, view_id)
            
            updated_count += 1
            print(f"  ✓ Reset view #{view_id}: {name} (node: '{node_name}', type={view_type})")
        
        print(f"\n✓ Successfully reset {updated_count} system views.")


async def main():
    """Main entry point."""
    print("=" * 60)
    print("Reset System Views to Default Conditions")
    print("=" * 60)
    print()
    
    # Confirm action
    response = input("This will reset all default system views. Continue? (yes/no): ")
    if response.lower() != 'yes':
        print("Aborted.")
        return
    
    print()
    await reset_system_views()
    print()
    print("Done!")


if __name__ == '__main__':
    asyncio.run(main())
