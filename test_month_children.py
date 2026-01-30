"""Test script to check month page children query."""
import asyncio
import asyncpg
from datetime import date

async def test_month_children():
    # Connect to the database
    conn = await asyncpg.connect(
        host='localhost',
        port=5432,
        database='notees',
        user='postgres',
        password='postgres'
    )
    
    try:
        # Get the first graph
        graph = await conn.fetchrow("SELECT id, uuid FROM graph LIMIT 1")
        if not graph:
            print("No graphs found!")
            return
        
        graph_id = graph['id']
        print(f"Using graph: {graph['uuid']} (id={graph_id})")
        
        # Create test month page if not exists
        month_uuid = "00000000-0000-0000-00aa-202601000000"  # January 2026
        month_node = await conn.fetchrow(
            "SELECT * FROM node WHERE uuid = $1 AND graph_id = $2",
            month_uuid, graph_id
        )
        
        if not month_node:
            print(f"\nMonth page not found (UUID: {month_uuid})")
            print("Please create it by navigating to January 2026 in the app")
            return
        
        print(f"\nFound month page: {month_node['name']} (id={month_node['id']})")
        print(f"  - is_month: {month_node['is_month']}")
        print(f"  - is_page: {month_node['is_page']}")
        print(f"  - parent_id: {month_node['parent_id']}")
        
        # Check for day pages that are children of this month
        day_pages = await conn.fetch("""
            SELECT id, uuid, name, parent_id, is_day, is_page
            FROM node
            WHERE parent_id = $1
              AND graph_id = $2
              AND active = TRUE
            ORDER BY uuid
        """, month_node['id'], graph_id)
        
        print(f"\n✓ Direct children of month page: {len(day_pages)}")
        for day in day_pages:
            print(f"  - {day['name']} (id={day['id']}, uuid={day['uuid']}, is_day={day['is_day']})")
        
        # Now test the query that the child pages section should use
        print("\n--- Testing Child Pages Query ---")
        print(f"Query: Find pages where parent.uuid = '{month_uuid}'")
        
        # This is what the system query should be doing
        child_query_results = await conn.fetch("""
            SELECT n.id, n.uuid, n.name, n.parent_id, n.is_day, n.is_page
            FROM node n
            WHERE n.graph_id = $1
              AND n.active = TRUE
              AND n.is_page = TRUE
              AND EXISTS (
                SELECT 1 FROM node parent
                WHERE parent.id = n.parent_id
                  AND parent.graph_id = $1
                  AND parent.active = TRUE
                  AND parent.uuid = $2
              )
            ORDER BY n.uuid
        """, graph_id, month_uuid)
        
        print(f"\n✓ Child pages query result: {len(child_query_results)}")
        for child in child_query_results:
            print(f"  - {child['name']} (id={child['id']}, uuid={child['uuid']})")
        
        if len(day_pages) == 0:
            print("\n⚠ No day pages found! Create a day page in January 2026 first.")
        elif len(child_query_results) == 0:
            print("\n❌ Query returned 0 results even though direct children exist!")
            print("This indicates a problem with the query logic.")
        elif len(child_query_results) != len(day_pages):
            print(f"\n⚠ Mismatch: {len(day_pages)} direct children but only {len(child_query_results)} query results")
        else:
            print("\n✅ Query works correctly!")
        
    finally:
        await conn.close()

if __name__ == "__main__":
    asyncio.run(test_month_children())
