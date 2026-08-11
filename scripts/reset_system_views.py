"""
Reset System Views Script

Resets all system views (linked_references, child_pages, classed_nodes) to their default
conditions with proper scope settings. Useful for migrating to new query structure.

Usage:
    # Run from outside Docker (connect to exposed port)
    DATABASE_URL=postgresql://notees:YOUR_PASSWORD@localhost:5432/notees python scripts/reset_system_views.py

    # Or run inside backend container
    docker compose exec backend python scripts/reset_system_views.py
"""
import asyncio
import json
import os
import sys
from pathlib import Path

# Add parent directory to path
sys.path.insert(0, str(Path(__file__).parent.parent))

# Load .env file if it exists
from dotenv import load_dotenv

from app.db.connection import get_connection

load_dotenv()


def _require_database_url() -> None:
    """Exit if DATABASE_URL is not configured."""
    if os.getenv('DATABASE_URL'):
        return
    print(
        "Error: DATABASE_URL environment variable is required.\n"
        "Example:\n"
        "  DATABASE_URL=postgresql://notees:YOUR_PASSWORD@localhost:5432/notees "
        "python scripts/reset_system_views.py"
    )
    sys.exit(1)


async def reset_system_views():
    """Reset all system views to default conditions."""

    # Default query structures for each view type using QueryAST format
    # Note: All conditions are marked as system nodes (is_system: true)
    default_queries = {
        'linked_references': {
            'type': 'query',
            'version': '1.0',
            'scope': {
                'type': 'scope',
                'scope_type': 'entire_workspace'
            },
            'root_group': {
                'type': 'group',
                'logic': 'AND',
                'children': [
                    {
                        'type': 'condition',
                        'condition_type': 'reference',
                        'target_uuid': '{current_node_uuid}',
                        'is_system': True
                    }
                ]
            },
            'is_system': True
        },
        'child_pages': {
            'type': 'query',
            'version': '1.0',
            'scope': {
                'type': 'scope',
                'scope_type': 'pages'
            },
            'root_group': {
                'type': 'group',
                'logic': 'AND',
                'children': [
                    {
                        'type': 'condition',
                        'condition_type': 'parent',
                        'parent_uuid': '{current_node_uuid}',
                        'operator': 'has_parent',
                        'is_system': True
                    }
                ]
            },
            'is_system': True
        },
        'classed_nodes': {
            'type': 'query',
            'version': '1.0',
            'scope': {
                'type': 'scope',
                'scope_type': 'entire_workspace'
            },
            'root_group': {
                'type': 'group',
                'logic': 'AND',
                'children': [
                    {
                        'type': 'condition',
                        'condition_type': 'class',
                        'class_uuid': '{current_node_uuid}',
                        'operator': 'contains',
                        'is_system': True
                    }
                ]
            },
            'is_system': True
        },
        'unlinked_references': {
            'type': 'query',
            'version': '1.0',
            'scope': {
                'type': 'scope',
                'scope_type': 'entire_workspace'
            },
            'root_group': {
                'type': 'group',
                'logic': 'AND',
                'children': [
                    {
                        'type': 'group',
                        'logic': 'OR',
                        'is_system': True,
                        'children': [
                            {
                                'type': 'condition',
                                'condition_type': 'content',
                                'operator': 'contains',
                                'value': '{current_node_name}',
                                'is_system': True
                            },
                            {
                                'type': 'condition',
                                'condition_type': 'content',
                                'operator': 'contains',
                                'value': '{current_node_uuid}',
                                'is_system': True
                            }
                        ]
                    },
                    {
                        'type': 'condition',
                        'condition_type': 'property',
                        'property_name': 'uuid',
                        'property_type': 'text',
                        'operator': 'not_equals',
                        'value': '{current_node_uuid}',
                        'is_system': True
                    },
                    {
                        'type': 'condition',
                        'condition_type': 'flag',
                        'flag_name': 'is_page',
                        'value': False,
                        'is_system': True
                    }
                ]
            },
            'is_system': True
        }
    }

    async with get_connection() as conn:
        # Get all system views with node names
        views = await conn.fetch("""
            SELECT nv.id, nv.node_id, nv.view_type, nv.name, nv.query_json, n.name as node_name
            FROM node_view nv
            JOIN node n ON n.id = nv.node_id
            WHERE nv.view_type IN ('linked_references', 'child_pages', 'classed_nodes', 'unlinked_references')
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
    _require_database_url()

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
