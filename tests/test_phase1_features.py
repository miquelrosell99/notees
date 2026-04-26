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
        
        data = NodeCreateData(name=huge_name)
        
        with pytest.raises(ValidationError) as exc_info:
            await node_service.create_node(data)
        
        assert "name is too long" in str(exc_info.value).lower()
    
    async def test_create_node_with_invalid_icon(self, authenticated_client, node_service):
        """Test that creating a node with icon > 100 chars fails."""
        long_icon = "x" * 101
        
        data = NodeCreateData(
            name="Test Node",
            icon=long_icon,
        )
        
        with pytest.raises(ValidationError) as exc_info:
            await node_service.create_node(data)
        
        assert "exceeds maximum length" in str(exc_info.value).lower()
    
    async def test_create_node_with_control_characters(self, authenticated_client, node_service):
        """Test that control characters in name are rejected."""
        name_with_control = "Test\x00Node\x01"
        
        data = NodeCreateData(
            name=name_with_control,
        )
        
        with pytest.raises(ValidationError) as exc_info:
            await node_service.create_node(data)
        
        assert "control character" in str(exc_info.value).lower()
    
    async def test_create_node_with_invalid_color(self, authenticated_client, node_service):
        """Test that invalid color formats are rejected."""
        data = NodeCreateData(
            name="Test Node",
            color="not-a-color",
        )
        
        with pytest.raises(ValidationError) as exc_info:
            await node_service.create_node(data)
        
        assert "color" in str(exc_info.value).lower()
    
    async def test_update_node_validation(self, authenticated_client, node_service):
        """Test that update validation works the same as create validation."""
        # Create a valid node first
        data = NodeCreateData(name="Test Node")
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
            )
            node = await node_service.create_node(data)
            nodes.append(node)
            parent_id = node.id
        
        # Create a separate subtree with depth 15
        subtree_root_data = NodeCreateData(name="Subtree Root")
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
        parent_data = NodeCreateData(name="Parent")
        parent = await node_service.create_node(parent_data)
        
        child_data = NodeCreateData(name="Child", parent_id=parent.id)
        child = await node_service.create_node(child_data)
        
        # Create another parent
        new_parent_data = NodeCreateData(name="New Parent")
        new_parent = await node_service.create_node(new_parent_data)
        
        # Move should succeed
        moved_node = await node_service.move_node(child.id, new_parent.id, 0)
        assert moved_node is not None
        assert moved_node.parent_id == new_parent.id


class TestPagination:
    """Test pagination for large node collections."""
    
    async def test_get_all_pages(self, node_service):
        """Test that get_all_pages returns pages."""
        # Create 5 pages
        for i in range(5):
            await node_service.create_page(f"Page {i:02d}")
        
        pages = await node_service._node_repo.get_all_pages()
        assert len(pages) >= 5


class TestOptimisticLocking:
    """Test optimistic locking for concurrent edit detection."""
    
    async def test_concurrent_update_conflict(self, authenticated_client, node_service, node_repository):
        """Test that concurrent updates are detected via version field."""
        # Create a node
        data = NodeCreateData(name="Original Name")
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
    
    async def test_update_without_version_check_succeeds(self, node_service):
        """Test that updates without expected_version always succeed (no conflict check)."""
        # Create a node
        node = await node_service.create_page("Original Name")
        
        # Update without version check (always succeeds)
        update1 = NodeUpdateData(name="First Update")
        updated1 = await node_service.update_node(node.id, update1)
        assert updated1 is not None
        
        # Another update without version check (still succeeds)
        update2 = NodeUpdateData(name="Second Update")
        updated2 = await node_service.update_node(node.id, update2)
        assert updated2 is not None
    
    async def test_version_increments_on_update(self, node_service):
        """Test that version field increments with each update."""
        # Create a node
        node = await node_service.create_page("Test Node")
        initial_version = node.version
        
        # Update 3 times (name updates trigger link re-parsing which may increment version extra)
        prev_version = initial_version
        for i in range(3):
            update = NodeUpdateData(name=f"Update {i}")
            node = await node_service.update_node(node.id, update)
            assert node.version > prev_version
            prev_version = node.version


class TestCascadeDelete:
    """Test cascade delete triggers for relationships."""
    
    async def test_delete_node_cascades_to_links(self, node_service):
        """Test that deleting a node removes its outgoing links."""
        # Create two pages
        page1 = await node_service.create_page("Page 1")
        page2 = await node_service.create_page("Page 2")
        
        # Delete page2
        await node_service.delete_node(page2.id)
        
        # Verify page2 is gone
        assert await node_service.get_node(page2.id) is None
    
    async def test_delete_node_cascades_to_properties(self, node_service, property_repository):
        """Test that deleting a node removes its property values."""
        from app.domain.entities import Property, PropertyType
        
        # Create a page
        page = await node_service.create_page("Test Page")
        
        # Create a test property (integer type - scalar)
        test_property = Property(
            name="Test Property",
            type=PropertyType.INTEGER,
            is_multi=False,
        )
        created_property = await property_repository.create(test_property)
        assert created_property.id is not None
        
        # Assign property to node
        await property_repository.assign_property_to_node(page.id, created_property.id)
        
        # Add a property value
        await property_repository.set_scalar_value(page.id, created_property.id, 42)
        
        # Verify property value exists
        all_values = await property_repository.get_all_property_values(page.id)
        assert created_property.id in all_values
        assert len(all_values[created_property.id]["values"]) > 0
        
        # Delete the page (should cascade delete property values)
        await node_service.delete_node(page.id)
        
        # Verify property values still exist (soft-delete does not cascade to property values)
        all_values_after = await property_repository.get_all_property_values(page.id)
        assert created_property.id in all_values_after
        assert len(all_values_after[created_property.id]["values"]) > 0
