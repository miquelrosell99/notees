"""
Migration script to rename system properties to have uppercase first letters.

This script updates existing databases to use the new capitalized property names:
- 'tags' -> 'Tags'
- 'show_hierarchy' -> 'Show hierarchy'
- 'used_in' -> 'Used in'
- 'cover' -> 'Cover'
- 'banner' -> 'Banner'

Usage:
    # Run from outside Docker (connect to exposed port)
    DATABASE_URL=postgresql://notees:change_me_dev_password@localhost:5432/notees python scripts/migrate_system_property_names.py
    
    # Or run inside backend container
    docker compose exec backend python scripts/migrate_system_property_names.py
"""
import asyncio
import os
import sys
from pathlib import Path

# Add parent directory to path
sys.path.insert(0, str(Path(__file__).parent.parent))

# Load .env file if it exists
from dotenv import load_dotenv
load_dotenv()

# Set DATABASE_URL if not already set (for running outside Docker)
if not os.getenv('DATABASE_URL'):
    os.environ['DATABASE_URL'] = 'postgresql://notees:change_me_dev_password@localhost:5432/notees'

from app.db.connection import get_connection


async def migrate_system_property_names():
    """Update system property names from lowercase to uppercase."""
    print("Starting system property name migration...")
    
    async with get_connection() as conn:
        # Update 'tags' to 'Tags'
        result = await conn.execute("""
            UPDATE property 
            SET name = 'Tags',
                write_date = CURRENT_TIMESTAMP
            WHERE uuid = '00000000-0000-0000-0000-000000000001' 
              AND name = 'tags' 
              AND is_system = TRUE
        """)
        # Parse result to get number of updated rows
        tags_count = int(result.split()[-1]) if result.startswith('UPDATE') else 0
        print(f"Updated {tags_count} 'tags' properties to 'Tags'")
        
        # Update 'show_hierarchy' to 'Show hierarchy'
        result = await conn.execute("""
            UPDATE property 
            SET name = 'Show hierarchy',
                write_date = CURRENT_TIMESTAMP
            WHERE uuid = '00000000-0000-0000-0000-000000000003' 
              AND name IN ('show_hierarchy', 'Show_hierarchy')
              AND is_system = TRUE
        """)
        # Parse result to get number of updated rows
        show_hierarchy_count = int(result.split()[-1]) if result.startswith('UPDATE') else 0
        print(f"Updated {show_hierarchy_count} 'show_hierarchy' properties to 'Show hierarchy'")
        
        # Update 'used_in' to 'Used in'
        result = await conn.execute("""
            UPDATE property 
            SET name = 'Used in',
                write_date = CURRENT_TIMESTAMP
            WHERE uuid = '00000000-0000-0000-0000-000000000004' 
              AND name IN ('used_in', 'Used_in')
              AND is_system = TRUE
        """)
        # Parse result to get number of updated rows
        used_in_count = int(result.split()[-1]) if result.startswith('UPDATE') else 0
        print(f"Updated {used_in_count} 'used_in' properties to 'Used in'")
        
        # Update 'cover' to 'Cover'
        result = await conn.execute("""
            UPDATE property 
            SET name = 'Cover',
                write_date = CURRENT_TIMESTAMP
            WHERE uuid = '00000000-0000-0000-0000-000000000005' 
              AND name = 'cover' 
              AND is_system = TRUE
        """)
        # Parse result to get number of updated rows
        cover_count = int(result.split()[-1]) if result.startswith('UPDATE') else 0
        print(f"Updated {cover_count} 'cover' properties to 'Cover'")
        
        # Update 'banner' to 'Banner'
        result = await conn.execute("""
            UPDATE property 
            SET name = 'Banner',
                write_date = CURRENT_TIMESTAMP
            WHERE uuid = '00000000-0000-0000-0000-000000000006' 
              AND name = 'banner' 
              AND is_system = TRUE
        """)
        # Parse result to get number of updated rows
        banner_count = int(result.split()[-1]) if result.startswith('UPDATE') else 0
        print(f"Updated {banner_count} 'banner' properties to 'Banner'")
        
    print("\nMigration completed successfully!")
    print(f"Total properties updated: {tags_count + show_hierarchy_count + used_in_count + cover_count + banner_count}")
    print("\nNOTE: System property UUIDs remain unchanged (backward compatible)")


if __name__ == "__main__":
    asyncio.run(migrate_system_property_names())
