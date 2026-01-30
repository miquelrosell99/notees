"""Test the child pages query fix."""
import asyncio
import asyncpg
from app.domain.services.node_view_service import DEFAULT_VIEW_CONFIGS
from app.domain.services.query_service import QueryService

async def test_child_pages_query():
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
        
        # Get the month page
        month_uuid = "00000000-0000-0000-00aa-202601000000"
        month_node = await conn.fetchrow(
            "SELECT * FROM node WHERE uuid = $1 AND graph_id = $2",
            month_uuid, graph_id
        )
        
        if not month_node:
            print(f"\n❌ Month page not found (UUID: {month_uuid})")
            return
        
        print(f"\nMonth page: {month_node['name']} (id={month_node['id']})")
        
        # Get the child pages query config
        config = DEFAULT_VIEW_CONFIGS['child_pages']
        query_ast = config['query_ast']
        
        print(f"\n--- Testing Child Pages Query AST ---")
        print(f"Query AST: {query_ast}")
        
        # Create query service
        pool = await asyncpg.create_pool(
            host='localhost',
            port=5432,
            database='notees',
            user='postgres',
            password='postgres'
        )
        
        query_service = QueryService(pool, graph_id)
        
        # Execute the query with runtime params
        runtime_params = {
            'current_node_uuid': month_uuid,
            'current_node_id': month_node['id']
        }
        
        results = await query_service.execute_query_ast(
            query_ast,
            runtime_params=runtime_params,
            include_children=False,
            include_properties=False
        )
        
        print(f"\n✓ Query returned {len(results)} results:")
        for node in results:
            print(f"  - {node.name} (id={node.id}, uuid={node.uuid})")
        
        if len(results) > 0:
            print("\n✅ SUCCESS! Child pages query is working correctly!")
        else:
            print("\n⚠ Query returned 0 results. Check if there are day pages.")
        
        await pool.close()
        
    finally:
        await conn.close()

if __name__ == "__main__":
    asyncio.run(test_child_pages_query())
