"""Script to add the extends property to existing databases."""
import asyncio
from app.db.connection import get_pool
from app.db.schema.constants import SYSTEM_PROPERTY_UUIDS, SYSTEM_CLASS_UUIDS
from datetime import datetime, timezone


async def add_extends_property():
    pool = await get_pool()
    async with pool.acquire() as conn:
        # Check if extends property exists
        row = await conn.fetchrow(
            'SELECT id FROM property WHERE uuid = $1',
            SYSTEM_PROPERTY_UUIDS['extends']
        )
        if row:
            print(f'✓ extends property already exists with id {row["id"]}')
            return
        
        # Create extends property
        now = datetime.now(timezone.utc)
        user_id = 1
        row = await conn.fetchrow("""
            INSERT INTO property (uuid, name, type, is_multi, is_system, create_date, write_date, create_uid, write_uid)
            VALUES ($1, 'extends', 'node', TRUE, TRUE, $2, $2, $3, $3)
            RETURNING id
        """, SYSTEM_PROPERTY_UUIDS['extends'], now, user_id)
        
        if row:
            extends_prop_id = row['id']
            print(f'✓ Created extends property with id {extends_prop_id}')
            
            # Get class node id
            class_row = await conn.fetchrow(
                'SELECT id FROM node WHERE uuid = $1',
                SYSTEM_CLASS_UUIDS['class']
            )
            if class_row:
                class_id = class_row['id']
                # Set class filter
                await conn.execute("""
                    INSERT INTO property_class_filter (property_id, class_node_id)
                    VALUES ($1, $2)
                    ON CONFLICT DO NOTHING
                """, extends_prop_id, class_id)
                print(f'✓ Added class filter for extends property (class_id: {class_id})')
            else:
                print('✗ Warning: Could not find class node')
        else:
            print('✗ Failed to create extends property')


if __name__ == '__main__':
    asyncio.run(add_extends_property())
