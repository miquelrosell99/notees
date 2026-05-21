"""Tests for soft-delete, restore, permanent delete, and trash functionality."""
import json

import pytest

from app.domain.entities import NodeUpdateData


@pytest.mark.asyncio
async def test_soft_delete_basic(node_service):
    """Test basic soft-delete functionality."""
    node = await node_service.create_page("Test Page")
    node_id = node.id

    success = await node_service.delete_node(node_id)
    assert success is True

    fetched = await node_service.get_node(node_id)
    assert fetched is None

    deleted_nodes = await node_service.get_deleted_nodes()
    assert any(n.id == node_id for n in deleted_nodes)


@pytest.mark.asyncio
async def test_soft_delete_with_children(node_service):
    """Test that soft-delete cascades to all descendants."""
    parent = await node_service.create_page("Parent")
    child1 = await node_service.create_block("Child 1", parent_id=parent.id, sequence=0)
    child2 = await node_service.create_block("Child 2", parent_id=parent.id, sequence=1)
    grandchild = await node_service.create_block("Grandchild", parent_id=child1.id, sequence=0)

    await node_service.delete_node(parent.id)

    deleted_nodes = await node_service.get_deleted_nodes()
    deleted_ids = {n.id for n in deleted_nodes}

    assert parent.id in deleted_ids
    assert child1.id in deleted_ids
    assert child2.id in deleted_ids
    assert grandchild.id in deleted_ids


@pytest.mark.asyncio
async def test_restore_node(node_service):
    """Test restoring a soft-deleted node."""
    node = await node_service.create_page("Test Page")
    node_id = node.id
    await node_service.delete_node(node_id)

    assert await node_service.get_node(node_id) is None

    restored = await node_service.restore_node(node_id)
    assert restored is not None
    assert restored.id == node_id

    fetched = await node_service.get_node(node_id)
    assert fetched is not None
    assert fetched.id == node_id
    assert fetched.active is True


@pytest.mark.asyncio
async def test_restore_node_with_descendants(node_service):
    """Test that restoring a node also restores all its descendants."""
    parent = await node_service.create_page("Parent")
    child1 = await node_service.create_block("Child 1", parent_id=parent.id, sequence=0)
    child2 = await node_service.create_block("Child 2", parent_id=parent.id, sequence=1)
    grandchild = await node_service.create_block("Grandchild", parent_id=child1.id, sequence=0)

    await node_service.delete_node(parent.id)

    assert await node_service.get_node(parent.id) is None
    assert await node_service.get_node(child1.id) is None
    assert await node_service.get_node(child2.id) is None
    assert await node_service.get_node(grandchild.id) is None

    restored = await node_service.restore_node(parent.id)
    assert restored is not None

    assert await node_service.get_node(parent.id) is not None
    assert await node_service.get_node(child1.id) is not None
    assert await node_service.get_node(child2.id) is not None
    assert await node_service.get_node(grandchild.id) is not None

    children = await node_service.get_node_children(parent.id)
    child_ids = {c.id for c in children}
    assert child1.id in child_ids
    assert child2.id in child_ids

    child1_children = await node_service.get_node_children(child1.id)
    assert len(child1_children) == 1
    assert child1_children[0].id == grandchild.id


@pytest.mark.asyncio
async def test_permanent_delete(node_service):
    """Test permanently deleting a soft-deleted node."""
    node = await node_service.create_page("Test Page")
    node_id = node.id
    await node_service.delete_node(node_id)

    success = await node_service.permanently_delete_node(node_id)
    assert success is True

    assert await node_service.get_node(node_id) is None

    deleted_nodes = await node_service.get_deleted_nodes()
    assert not any(n.id == node_id for n in deleted_nodes)


@pytest.mark.asyncio
async def test_soft_delete_filters_in_queries(node_service):
    """Test that soft-deleted nodes are filtered from normal queries."""
    page1 = await node_service.create_page("Page 1")
    page2 = await node_service.create_page("Page 2")
    page3 = await node_service.create_page("Page 3")

    await node_service.delete_node(page2.id)

    all_pages = await node_service.get_all_pages()
    page_ids = {p.id for p in all_pages}
    assert page1.id in page_ids
    assert page2.id not in page_ids
    assert page3.id in page_ids

    search_results = await node_service.search("Page")
    search_ids = {p.id for p in search_results}
    assert page2.id not in search_ids


@pytest.mark.asyncio
async def test_delete_node_cascades_to_links(node_service):
    """Test that deleting a node removes its outgoing links."""
    page1 = await node_service.create_page("Page 1")
    page2 = await node_service.create_page("Page 2")

    await node_service.delete_node(page2.id)

    assert await node_service.get_node(page2.id) is None


@pytest.mark.asyncio
async def test_permanent_delete_replaces_links_in_content(node_service):
    """Test that permanently deleting a node replaces node_link AST nodes with plain text."""
    target = await node_service.create_page("Target Page")
    source_page = await node_service.create_page("Source Page")
    # Create a block (not a page) with an actual node_link AST node referencing the target
    source_ast = json.dumps([{
        "type": "paragraph",
        "children": [
            {"type": "text", "text": "Source with "},
            {"type": "node_link", "link_id": str(target.id), "ref_type": "node"}
        ]
    }])
    source_block = await node_service.create_block(source_ast, parent_id=source_page.id, sequence=0)
    # Sync links so node_link record is created
    await node_service.update_node_links(source_block.id, source_block.name)

    await node_service.delete_node(target.id)
    success = await node_service.permanently_delete_node(target.id)
    assert success is True

    updated_source = await node_service.get_node(source_block.id)
    assert updated_source is not None
    assert "Target Page" in updated_source.name
    # The node_link AST node should have been replaced with a text node
    assert '"type": "node_link"' not in updated_source.name


@pytest.mark.asyncio
async def test_delete_node_cascades_to_properties(node_service, property_repository):
    """Test that deleting a node removes its property values."""
    from app.domain.entities import Property, PropertyType

    page = await node_service.create_page("Test Page")

    test_property = Property(
        name="Test Property",
        type=PropertyType.INTEGER,
        is_multi=False,
    )
    created_property = await property_repository.create(test_property)
    assert created_property.id is not None

    await property_repository.assign_property_to_node(page.id, created_property.id)
    await property_repository.set_scalar_value(page.id, created_property.id, 42)

    all_values = await property_repository.get_all_property_values(page.id)
    assert created_property.id in all_values
    assert len(all_values[created_property.id]["values"]) > 0

    await node_service.delete_node(page.id)

    all_values_after = await property_repository.get_all_property_values(page.id)
    assert created_property.id in all_values_after
    assert len(all_values_after[created_property.id]["values"]) > 0
