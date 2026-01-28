"""
Tests for Phase 0 features: Soft-delete, circular reference prevention, and transactional operations.
"""
import pytest
from datetime import datetime, timezone

from app.domain.entities import NodeCreateData, NodeUpdateData
from app.domain.services.node_service import NodeService
from app.domain.services.link_service import LinkParsingService
from app.domain.repositories.postgres_node import PostgresNodeRepository
from app.domain.repositories.postgres_link import PostgresLinkRepository
from app.domain.repositories.postgres_property import PostgresPropertyRepository


@pytest.mark.asyncio
async def test_circular_reference_prevention(authenticated_client, test_graph_id):
    """Test that circular references are prevented in move_node."""
    # Create a hierarchy: A -> B -> C
    service = authenticated_client["node_service"]
    
    # Create parent A
    node_a = await service.create_page("Node A")
    
    # Create child B under A
    node_b = await service.create_block("Node B", parent_id=node_a.id, sequence=0)
    
    # Create child C under B
    node_c = await service.create_block("Node C", parent_id=node_b.id, sequence=0)
    
    # Try to move A under C (would create circular reference: A -> B -> C -> A)
    with pytest.raises(ValueError, match="circular reference"):
        await service.move_node(node_a.id, node_c.id, 0)
    
    # Try to move A under B (would create circular reference: A -> B -> A)
    with pytest.raises(ValueError, match="circular reference"):
        await service.move_node(node_a.id, node_b.id, 0)
    
    # Try to move node to itself (edge case)
    with pytest.raises(ValueError, match="own parent"):
        await service.move_node(node_a.id, node_a.id, 0)
    
    # Verify valid moves still work
    node_d = await service.create_page("Node D")
    result = await service.move_node(node_b.id, node_d.id, 0)
    assert result is not None
    assert result.parent_id == node_d.id


@pytest.mark.asyncio
async def test_soft_delete_basic(authenticated_client):
    """Test basic soft-delete functionality."""
    service = authenticated_client["node_service"]
    pool = service._node_repo.get_connection()
    
    # Create a node
    node = await service.create_page("Test Page")
    node_id = node.id
    
    # Soft-delete the node
    success = await service.delete_node(node_id)
    assert success is True
    
    # Verify node is soft-deleted in database
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT is_deleted, deleted_at FROM node WHERE id = $1",
            node_id
        )
        assert row is not None
        assert row['is_deleted'] is True
        assert row['deleted_at'] is not None
    
    # Verify node is not returned by normal queries
    fetched = await service.get_node(node_id)
    assert fetched is None
    
    # Verify node appears in trash
    deleted_nodes = await service.get_deleted_nodes()
    assert any(n.id == node_id for n in deleted_nodes)


@pytest.mark.asyncio
async def test_soft_delete_with_children(authenticated_client):
    """Test that soft-delete cascades to all descendants."""
    service = authenticated_client["node_service"]
    
    # Create hierarchy
    parent = await service.create_page("Parent")
    child1 = await service.create_block("Child 1", parent_id=parent.id, sequence=0)
    child2 = await service.create_block("Child 2", parent_id=parent.id, sequence=1)
    grandchild = await service.create_block("Grandchild", parent_id=child1.id, sequence=0)
    
    # Soft-delete parent
    await service.delete_node(parent.id)
    
    # Verify all descendants are soft-deleted
    deleted_nodes = await service.get_deleted_nodes()
    deleted_ids = {n.id for n in deleted_nodes}
    
    assert parent.id in deleted_ids
    assert child1.id in deleted_ids
    assert child2.id in deleted_ids
    assert grandchild.id in deleted_ids


@pytest.mark.asyncio
async def test_restore_node(authenticated_client):
    """Test restoring a soft-deleted node."""
    service = authenticated_client["node_service"]
    
    # Create and delete a node
    node = await service.create_page("Test Page")
    node_id = node.id
    await service.delete_node(node_id)
    
    # Verify it's in trash
    assert await service.get_node(node_id) is None
    
    # Restore the node
    restored = await service.restore_node(node_id)
    assert restored is not None
    assert restored.id == node_id
    
    # Verify it's no longer in trash and can be fetched normally
    fetched = await service.get_node(node_id)
    assert fetched is not None
    assert fetched.id == node_id
    
    # Verify is_deleted is false
    pool = service._node_repo.get_connection()
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT is_deleted, deleted_at FROM node WHERE id = $1",
            node_id
        )
        assert row['is_deleted'] is False
        assert row['deleted_at'] is None


@pytest.mark.asyncio
async def test_permanent_delete(authenticated_client):
    """Test permanently deleting a soft-deleted node."""
    service = authenticated_client["node_service"]
    pool = service._node_repo.get_connection()
    
    # Create and soft-delete a node
    node = await service.create_page("Test Page")
    node_id = node.id
    await service.delete_node(node_id)
    
    # Permanently delete
    success = await service.permanently_delete_node(node_id)
    assert success is True
    
    # Verify node is completely removed from database
    async with pool.acquire() as conn:
        row = await conn.fetchrow("SELECT id FROM node WHERE id = $1", node_id)
        assert row is None
    
    # Verify it's not in trash
    deleted_nodes = await service.get_deleted_nodes()
    assert not any(n.id == node_id for n in deleted_nodes)


@pytest.mark.asyncio
async def test_soft_delete_filters_in_queries(authenticated_client):
    """Test that soft-deleted nodes are filtered from all normal queries."""
    service = authenticated_client["node_service"]
    
    # Create several pages
    page1 = await service.create_page("Page 1")
    page2 = await service.create_page("Page 2")
    page3 = await service.create_page("Page 3")
    
    # Soft-delete page2
    await service.delete_node(page2.id)
    
    # Verify get_all_pages doesn't include deleted node
    all_pages = await service.get_all_pages()
    page_ids = {p.id for p in all_pages}
    assert page1.id in page_ids
    assert page2.id not in page_ids  # Deleted
    assert page3.id in page_ids
    
    # Verify search doesn't include deleted node
    search_results = await service.search("Page")
    search_ids = {p.id for p in search_results}
    assert page2.id not in search_ids


@pytest.mark.asyncio
async def test_asset_folder_deletion(authenticated_client, tmp_path):
    """Test that asset folders are deleted when asset nodes are soft-deleted."""
    # This test would require setting up asset infrastructure
    # Marking as TODO for now since AssetService integration needs setup
    pytest.skip("Asset integration test - requires AssetService setup")


@pytest.mark.asyncio
async def test_transactional_node_creation_with_links(authenticated_client):
    """Test that node creation with link parsing happens in a single transaction.
    
    Note: Current implementation has link parsing after node creation.
    This test documents expected behavior for future transaction refactoring.
    """
    service = authenticated_client["node_service"]
    
    # Create target node
    target = await service.create_page("Target")
    
    # Create node with link
    source = await service.create_page(f"Source with link [[{target.id}]]")
    
    # Verify link was created
    backlinks = await service._link_service.get_backlinks(target.id)
    assert len(backlinks) > 0
    assert any(bl.source_node_id == source.id for bl in backlinks)


@pytest.mark.asyncio  
async def test_node_update_with_links_atomic(authenticated_client):
    """Test that node updates with link changes happen atomically."""
    service = authenticated_client["node_service"]
    
    # Create nodes
    target1 = await service.create_page("Target 1")
    target2 = await service.create_page("Target 2")
    source = await service.create_page(f"Source with [[{target1.id}]]")
    
    # Update to link to different target
    await service.update_node(
        source.id,
        NodeUpdateData(name=f"Updated source [[{target2.id}]]")
    )
    
    # Verify old link is gone
    backlinks_t1 = await service._link_service.get_backlinks(target1.id)
    assert not any(bl.source_node_id == source.id for bl in backlinks_t1)
    
    # Verify new link exists
    backlinks_t2 = await service._link_service.get_backlinks(target2.id)
    assert any(bl.source_node_id == source.id for bl in backlinks_t2)


@pytest.mark.asyncio
async def test_delete_node_replaces_links_in_content(authenticated_client):
    """Test that deleting a node replaces [[id]] links with the node name."""
    service = authenticated_client["node_service"]
    
    # Create target and source
    target = await service.create_page("Target Page")
    source = await service.create_page(f"Source with [[{target.id}]]")
    
    # Delete target
    await service.delete_node(target.id)
    
    # Verify source content updated with target name
    updated_source = await service.get_node(source.id)
    assert updated_source is not None
    assert "Target Page" in updated_source.name
    assert f"[[{target.id}]]" not in updated_source.name


@pytest.mark.asyncio
async def test_undo_redo_metadata(authenticated_client):
    """Test that history metadata is preserved for undo/redo operations.
    
    Note: This tests the data model - actual undo/redo logic is in frontend historyStore.
    """
    service = authenticated_client["node_service"]
    
    # Create a node
    node = await service.create_page("Original")
    
    # Update it
    updated = await service.update_node(
        node.id,
        NodeUpdateData(name="Updated")
    )
    
    # Verify version incremented (for optimistic locking/conflict detection)
    assert updated.version > node.version
    assert updated.write_date > node.create_date


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
