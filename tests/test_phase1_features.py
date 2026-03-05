"""Test Phase 1 features: validation, max depth, pagination, conflict detection.

Phase 1 Features:
- Input validation (node name, icon, color)
- Max hierarchy depth enforcement
- Pagination for large node collections
- Optimistic locking for concurrent edits
"""
import pytest
import asyncio
from app.domain.entities import NodeCreateData, NodeUpdateData
from app.domain.errors import OptimisticLockError
from app.domain.validation import ValidationError


class TestInputValidation:
    """Test input validation for node create/update operations."""
    
    async def test_create_node_with_oversized_name(self, authenticated_client, node_service):
        """Test that creating a node with name > 50KB fails."""
        huge_name = "x" * (50 * 1024 + 1)  # 50KB + 1 byte
        
        data = NodeCreateData(
            name=huge_name,
            is_page=True,
        )
        
        with pytest.raises(ValidationError) as exc_info:
            await node_service.create_node(data)
        
        assert "name is too long" in str(exc_info.value).lower()
    
    async def test_create_node_with_invalid_icon(self, authenticated_client, node_service):
        """Test that creating a node with icon > 100 chars fails."""
        long_icon = "x" * 101
        
        data = NodeCreateData(
            name="Test Node",
            icon=long_icon,
            is_page=True,
        )
        
        with pytest.raises(ValidationError) as exc_info:
            await node_service.create_node(data)
        
        assert "icon is too long" in str(exc_info.value).lower()
    
    async def test_create_node_with_control_characters(self, authenticated_client, node_service):
        """Test that control characters in name are rejected."""
        name_with_control = "Test\x00Node\x01"
        
        data = NodeCreateData(
            name=name_with_control,
            is_page=True,
        )
        
        with pytest.raises(ValidationError) as exc_info:
            await node_service.create_node(data)
        
        assert "control character" in str(exc_info.value).lower()
    
    async def test_create_node_with_invalid_color(self, authenticated_client, node_service):
        """Test that invalid color formats are rejected."""
        data = NodeCreateData(
            name="Test Node",
            color="not-a-color",
            is_page=True,
        )
        
        with pytest.raises(ValidationError) as exc_info:
            await node_service.create_node(data)
        
        assert "color" in str(exc_info.value).lower()
    
    async def test_update_node_validation(self, authenticated_client, node_service):
        """Test that update validation works the same as create validation."""
        # Create a valid node first
        data = NodeCreateData(name="Test Node", is_page=True)
        node = await node_service.create_node(data)
        
        # Try to update with invalid data
        huge_name = "x" * (50 * 1024 + 1)
        update_data = NodeUpdateData(name=huge_name)
        
        with pytest.raises(ValidationError):
            await node_service.update_node(node.id, update_data)


class TestMaxHierarchyDepth:
    """Test maximum hierarchy depth enforcement."""
    
    async def test_move_node_exceeds_max_depth(self, authenticated_client, node_service):
        """Test that moving a node to exceed MAX_HIERARCHY_DEPTH fails."""
        from app.domain.services.node_service import MAX_HIERARCHY_DEPTH
        
        # Create a deep hierarchy (slightly under limit)
        parent_id = None
        nodes = []
        
        # Create chain close to max depth
        for i in range(MAX_HIERARCHY_DEPTH - 10):
            data = NodeCreateData(
                name=f"Node {i}",
                parent_id=parent_id,
                is_page=parent_id is None,  # First node is page, rest are blocks
            )
            node = await node_service.create_node(data)
            nodes.append(node)
            parent_id = node.id
        
        # Create a separate subtree with depth 15
        subtree_root_data = NodeCreateData(name="Subtree Root", is_page=True)
        subtree_root = await node_service.create_node(subtree_root_data)
        
        subtree_parent_id = subtree_root.id
        for i in range(15):
            data = NodeCreateData(
                name=f"Subtree {i}",
                parent_id=subtree_parent_id,
            )
            node = await node_service.create_node(data)
            subtree_parent_id = node.id
        
        # Try to move the subtree under the deep hierarchy
        # This would create depth of (MAX_HIERARCHY_DEPTH - 10) + 1 + 15 > MAX_HIERARCHY_DEPTH
        with pytest.raises(ValueError) as exc_info:
            await node_service.move_node(subtree_root.id, parent_id, 0)
        
        assert "maximum hierarchy depth" in str(exc_info.value).lower()
    
    async def test_move_node_within_depth_limit_succeeds(self, authenticated_client, node_service):
        """Test that moves within the depth limit succeed."""
        # Create a shallow hierarchy
        parent_data = NodeCreateData(name="Parent", is_page=True)
        parent = await node_service.create_node(parent_data)
        
        child_data = NodeCreateData(name="Child", parent_id=parent.id)
        child = await node_service.create_node(child_data)
        
        # Create another parent
        new_parent_data = NodeCreateData(name="New Parent", is_page=True)
        new_parent = await node_service.create_node(new_parent_data)
        
        # Move should succeed
        moved_node = await node_service.move_node(child.id, new_parent.id, 0)
        assert moved_node is not None
        assert moved_node.parent_id == new_parent.id


class TestPagination:
    """Test pagination for large node collections."""
    
    async def test_get_all_pages_with_pagination(self, authenticated_client, node_repo):
        """Test that get_all_pages supports limit and offset."""
        # Create 20 pages
        for i in range(20):
            data = NodeCreateData(name=f"Page {i:02d}", is_page=True)
            await node_repo.create(data)
        
        # Get first page (10 items)
        page1 = await node_repo.get_all_pages(limit=10, offset=0)
        assert len(page1) == 10
        
        # Get second page (10 items)
        page2 = await node_repo.get_all_pages(limit=10, offset=10)
        assert len(page2) == 10
        
        # Ensure no overlap
        page1_ids = {n.id for n in page1}
        page2_ids = {n.id for n in page2}
        assert len(page1_ids & page2_ids) == 0
    
    async def test_get_all_pages_respects_limit(self, authenticated_client, node_repo):
        """Test that limit parameter is respected."""
        # Create 50 pages
        for i in range(50):
            data = NodeCreateData(name=f"Page {i:02d}", is_page=True)
            await node_repo.create(data)
        
        # Request only 5
        pages = await node_repo.get_all_pages(limit=5)
        assert len(pages) <= 5


class TestOptimisticLocking:
    """Test optimistic locking for concurrent edit detection."""
    
    async def test_concurrent_update_conflict(self, authenticated_client, node_service, node_repo):
        """Test that concurrent updates are detected via version field."""
        # Create a node
        data = NodeCreateData(name="Original Name", is_page=True)
        node = await node_service.create_node(data)
        original_version = node.version
        
        # Simulate first update (succeeds)
        update1 = NodeUpdateData(name="Updated by User 1")
        updated1 = await node_service.update_node(
            node.id, 
            update1, 
            expected_version=original_version
        )
        assert updated1 is not None
        assert updated1.version == original_version + 1
        
        # Simulate second update with stale version (should fail)
        update2 = NodeUpdateData(name="Updated by User 2")
        with pytest.raises(OptimisticLockError) as exc_info:
            await node_service.update_node(
                node.id, 
                update2, 
                expected_version=original_version  # Stale version!
            )
        
        assert "version" in str(exc_info.value).lower()
        assert str(node.id) in str(exc_info.value) or "conflict" in str(exc_info.value).lower()
    
    async def test_update_without_version_check_succeeds(self, authenticated_client, node_service):
        """Test that updates without expected_version always succeed (no conflict check)."""
        # Create a node
        data = NodeCreateData(name="Original Name", is_page=True)
        node = await node_service.create_node(data)
        
        # Update without version check (always succeeds)
        update1 = NodeUpdateData(name="First Update")
        updated1 = await node_service.update_node(node.id, update1)
        assert updated1 is not None
        
        # Another update without version check (still succeeds)
        update2 = NodeUpdateData(name="Second Update")
        updated2 = await node_service.update_node(node.id, update2)
        assert updated2 is not None
        assert updated2.name == "Second Update"
    
    async def test_version_increments_on_update(self, authenticated_client, node_service):
        """Test that version field increments with each update."""
        # Create a node
        data = NodeCreateData(name="Test Node", is_page=True)
        node = await node_service.create_node(data)
        initial_version = node.version
        
        # Update 3 times
        for i in range(3):
            update = NodeUpdateData(name=f"Update {i}")
            node = await node_service.update_node(node.id, update)
            assert node.version == initial_version + i + 1


class TestCascadeDelete:
    """Test cascade delete triggers for relationships."""
    
    async def test_delete_node_cascades_to_links(self, authenticated_client, node_service):
        """Test that deleting a node removes its links."""
        # Create two pages and link between them
        page1_data = NodeCreateData(name="Page 1", is_page=True)
        page1 = await node_service.create_node(page1_data)
        
        page2_data = NodeCreateData(name=f"Page 2 [[{page1.id}]]", is_page=True)
        page2 = await node_service.create_node(page2_data)
        
        # Verify link exists
        backlinks = await node_service._link_service.get_backlinks(page1.id)
        assert len(backlinks) > 0
        
        # Delete page2 (should cascade delete the link)
        await node_service.delete_node(page2.id)
        
        # Verify link is gone
        backlinks_after = await node_service._link_service.get_backlinks(page1.id)
        assert len(backlinks_after) == 0
    
    async def test_delete_node_cascades_to_properties(self, authenticated_client, node_service):
        """Test that deleting a node removes its property values."""
        from app.domain.entities import Property, PropertyType
        
        # Get property repo from authenticated client
        property_repo = authenticated_client.get("property_repo")
        if not property_repo:
            pytest.skip("Property repository not available in test fixtures")
            return
        
        # Create a page
        page_data = NodeCreateData(name="Test Page", is_page=True)
        page = await node_service.create_node(page_data)
        
        # Create a test property (text type)
        test_property = Property(
            name="Test Property",
            type=PropertyType.TEXT,
            is_multi=False,
        )
        created_property = await property_repo.create(test_property)
        assert created_property.id is not None
        
        # Assign property to node
        await property_repo.assign_property_to_node(page.id, created_property.id)
        
        # Add a property value
        from app.domain.entities import PropertyScalarValue
        value = PropertyScalarValue(
            node_id=page.id,
            property_id=created_property.id,
            value="Test value"
        )
        await property_repo.set_scalar_value(value)
        
        # Verify property value exists
        all_values = await property_repo.get_all_property_values(page.id)
        assert created_property.id in all_values
        assert len(all_values[created_property.id]["values"]) > 0
        
        # Delete the page (should cascade delete property values)
        await node_service.delete_node(page.id)
        
        # Verify property values are gone (node is soft-deleted, but values should be removed)
        # Note: Depending on implementation, soft-deleted nodes might keep values
        # This test documents expected behavior
        all_values_after = await property_repo.get_all_property_values(page.id)
        # Either no values exist, or the node_property assignment is gone
        assert len(all_values_after) == 0 or created_property.id not in all_values_after
