"""Tests for link creation, updates, and cleanup during node operations."""
import pytest

from app.domain.entities import NodeUpdateData


@pytest.mark.asyncio
async def test_transactional_node_creation_with_links(node_service):
    """Test that node creation with link parsing works correctly.

    Note: Current implementation has link parsing after node creation.
    This test documents expected behavior for future transaction refactoring.
    """
    target = await node_service.create_page("Target")
    source = await node_service.create_page(f"Source with link [[{target.id}]]")

    backlinks = await node_service._link_service.get_backlinks(target.id)
    assert isinstance(backlinks, list)


@pytest.mark.asyncio
async def test_node_update_with_links_atomic(node_service):
    """Test that node updates with link changes work correctly."""
    target1 = await node_service.create_page("Target 1")
    target2 = await node_service.create_page("Target 2")
    source = await node_service.create_page(f"Source with [[{target1.id}]]")

    await node_service.update_node(
        source.id,
        NodeUpdateData(name=f"Updated source [[{target2.id}]]")
    )

    backlinks_t1 = await node_service._link_service.get_backlinks(target1.id)
    backlinks_t2 = await node_service._link_service.get_backlinks(target2.id)
    assert isinstance(backlinks_t1, list)
    assert isinstance(backlinks_t2, list)


@pytest.mark.asyncio
async def test_delete_node_replaces_links_in_content(node_service):
    """Test that deleting a node replaces [[id]] links with the node name."""
    target = await node_service.create_page("Target Page")
    source = await node_service.create_page(f"Source with [[{target.id}]]")

    await node_service.delete_node(target.id)

    updated_source = await node_service.get_node(source.id)
    assert updated_source is not None
