"""Test that date pages (day, month, year) don't process "/" for hierarchical creation.

This test verifies that the hierarchical page creation feature (using "/" to create 
parent/child relationships) is disabled for date pages.
"""
import pytest
from app.domain.entities.node import NodeCreateData
from app.domain.services.node_service import NodeService
from app.db.schema.constants import SYSTEM_CLASS_UUIDS


@pytest.mark.asyncio
async def test_date_page_slash_disabled(node_service: NodeService):
    """Test that / in date page names doesn't trigger hierarchical creation."""
    # Create a node with day class and "/" in name
    # This should NOT create a parent page
    day_class_id = SYSTEM_CLASS_UUIDS["day"]
    
    data = NodeCreateData(
        name="2026/01/29",  # Name contains "/"
        classes=[day_class_id],
    )
    
    # Create the node
    created_node = await node_service.create_node(data)
    
    # The name should remain as-is (not split)
    assert created_node.name == "2026/01/29"
    # It should have the day flag
    assert created_node.is_day is True
    # It should NOT have a parent (hierarchical creation disabled)
    assert created_node.parent_id is None


@pytest.mark.asyncio 
async def test_normal_page_slash_enabled(node_service: NodeService):
    """Test that / in normal page names still triggers hierarchical creation."""
    # Get the page class ID
    page_class_id = await node_service._node_repo.get_page_class_id()
    
    data = NodeCreateData(
        name="Projects/Work",  # Name contains "/"
        classes=[page_class_id],
    )
    
    # Create the node
    created_node = await node_service.create_node(data)
    
    # The name should be split - only "Work" remains
    assert created_node.name == "Work"
    # It should have the page flag
    assert created_node.is_page is True
    # It SHOULD have a parent (the "Projects" page created automatically)
    assert created_node.parent_id is not None
    
    # Verify the parent exists and is named "Projects"
    parent = await node_service._node_repo.get_by_id(created_node.parent_id)
    assert parent is not None
    assert parent.name == "Projects"
    assert parent.is_page is True
