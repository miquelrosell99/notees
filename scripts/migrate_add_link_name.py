"""Migration script to add 'name' field to node_link table.

Run this script once to add the custom link name feature.
"""
import asyncio
import sys
from pathlib import Path

# Add parent directory to path so we can import app
sys.path.insert(0, str(Path(__file__).parent.parent))

from app.db.connection import get_connection


async def migrate():
    """Add name column to node_link table."""
    async with get_connection() as conn:
        # Check if column already exists
        result = await conn.fetchrow("""
            SELECT column_name 
            FROM information_schema.columns 
            WHERE table_name = 'node_link' AND column_name = 'name'
        """)
        
        if result:
            print("Column 'name' already exists in node_link table. Skipping migration.")
            return
        
        # Add the column
        print("Adding 'name' column to node_link table...")
        await conn.execute("""
            ALTER TABLE node_link 
            ADD COLUMN name TEXT
        """)
        print("Migration completed successfully!")


if __name__ == "__main__":
    asyncio.run(migrate())
