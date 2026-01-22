"""Tests for system type constraints.

This tests the following constraints:
1. Users cannot add "day", "month", or "year" types to nodes manually
2. Users cannot remove "day", "month", or "year" types from nodes
3. System types cannot have the "type" type removed from them
"""
import pytest

from app.db.schema import SYSTEM_TYPE_UUIDS, SYSTEM_PROPERTY_UUIDS


@pytest.fixture
async def node_service(db_pool, test_user):
    """Create a NodeService for testing."""
    from app.domain.repositories import (
        PostgresNodeRepository,
        PostgresPropertyRepository,
        PostgresLinkRepository,
    )
    from app.domain.services import NodeService, LinkParsingService
    
    workspace_id = test_user["workspace_id"]
    
    # Get system type IDs from workspace
    async with db_pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT id FROM node WHERE uuid = $1 AND workspace_id = $2",
            SYSTEM_TYPE_UUIDS['page'], workspace_id
        )
        page_type_id = row['id']
        
        row = await conn.fetchrow(
            "SELECT id FROM property WHERE uuid = $1",
            SYSTEM_PROPERTY_UUIDS['types']
        )
        types_property_id = row['id']
    
    # Create repositories
    node_repo = PostgresNodeRepository(db_pool, workspace_id)
    property_repo = PostgresPropertyRepository(db_pool, workspace_id)
    link_repo = PostgresLinkRepository(db_pool, workspace_id)
    
    # Create services
    link_service = LinkParsingService(
        node_repo, link_repo,
        types_property_id=types_property_id
    )
    service = NodeService(
        node_repo, property_repo, link_service,
        page_type_id, types_property_id
    )
    
    return service


@pytest.fixture
async def system_type_ids(db_pool, test_user):
    """Get system type IDs for the test workspace."""
    workspace_id = test_user["workspace_id"]
    
    async with db_pool.acquire() as conn:
        ids = {}
        for name in ['day', 'month', 'year', 'type', 'task', 'page']:
            row = await conn.fetchrow(
                "SELECT id FROM node WHERE uuid = $1 AND workspace_id = $2",
                SYSTEM_TYPE_UUIDS[name], workspace_id
            )
            ids[name] = row['id'] if row else None
        
        # Also get 'types' property ID
        row = await conn.fetchrow(
            "SELECT id FROM property WHERE uuid = $1",
            SYSTEM_PROPERTY_UUIDS['types']
        )
        ids['types_property'] = row['id'] if row else None
    
    return ids


@pytest.mark.asyncio
async def test_cannot_add_day_type(node_service, system_type_ids):
    """Test that adding 'day' type manually is rejected."""
    from app.domain.errors import SystemTypeConstraintError
    
    service = node_service
    day_type_id = system_type_ids['day']
    
    # Create a test page
    page = await service.create_page("Test Page")
    
    # Try to add day type manually - should fail
    with pytest.raises(SystemTypeConstraintError) as exc_info:
        await service.add_type(page.id, day_type_id)
    
    assert "day" in exc_info.value.message.lower()
    assert "managed by the system" in exc_info.value.message.lower()


@pytest.mark.asyncio
async def test_cannot_add_month_type(node_service, system_type_ids):
    """Test that adding 'month' type manually is rejected."""
    from app.domain.errors import SystemTypeConstraintError
    
    service = node_service
    month_type_id = system_type_ids['month']
    
    # Create a test page
    page = await service.create_page("Test Page")
    
    # Try to add month type manually - should fail
    with pytest.raises(SystemTypeConstraintError) as exc_info:
        await service.add_type(page.id, month_type_id)
    
    assert "month" in exc_info.value.message.lower()


@pytest.mark.asyncio
async def test_cannot_add_year_type(node_service, system_type_ids):
    """Test that adding 'year' type manually is rejected."""
    from app.domain.errors import SystemTypeConstraintError
    
    service = node_service
    year_type_id = system_type_ids['year']
    
    # Create a test page
    page = await service.create_page("Test Page")
    
    # Try to add year type manually - should fail
    with pytest.raises(SystemTypeConstraintError) as exc_info:
        await service.add_type(page.id, year_type_id)
    
    assert "year" in exc_info.value.message.lower()


@pytest.mark.asyncio
async def test_cannot_remove_day_type(node_service, system_type_ids):
    """Test that removing 'day' type is rejected even if a node has it."""
    from app.domain.errors import SystemTypeConstraintError
    
    service = node_service
    day_type_id = system_type_ids['day']
    
    # Create a test page (imagine this was somehow given day type)
    page = await service.create_page("Test Page")
    
    # Try to remove day type - should fail
    with pytest.raises(SystemTypeConstraintError) as exc_info:
        await service.remove_type(page.id, day_type_id)
    
    assert "day" in exc_info.value.message.lower()
    assert "managed by the system" in exc_info.value.message.lower()


@pytest.mark.asyncio
async def test_cannot_remove_type_from_system_type(node_service, system_type_ids):
    """Test that removing 'type' from a system type node is rejected."""
    from app.domain.errors import SystemTypeConstraintError
    
    service = node_service
    type_type_id = system_type_ids['type']
    task_type_id = system_type_ids['task']
    
    # Try to remove 'type' from task type - should fail
    with pytest.raises(SystemTypeConstraintError) as exc_info:
        await service.remove_type(task_type_id, type_type_id)
    
    assert "type" in exc_info.value.message.lower()
    assert "system" in exc_info.value.message.lower()


@pytest.mark.asyncio
async def test_can_add_regular_type(node_service, system_type_ids):
    """Test that adding a regular (non-date) type works."""
    service = node_service
    task_type_id = system_type_ids['task']
    
    # Create a test page
    page = await service.create_page("Test Page")
    
    # Add task type - should succeed (no exception)
    success = await service.add_type(page.id, task_type_id)
    assert success is True


@pytest.mark.asyncio
async def test_can_remove_regular_type(node_service, system_type_ids):
    """Test that removing a regular (non-date) type works."""
    service = node_service
    task_type_id = system_type_ids['task']
    
    # Create a test page and add task type
    page = await service.create_page("Test Page")
    await service.add_type(page.id, task_type_id)
    
    # Remove task type - should succeed
    success = await service.remove_type(page.id, task_type_id)
    assert success is True
    
    # Verify type was removed
    types = await service.get_node_types(page.id)
    type_names = [t.name for t in types]
    assert "task" not in type_names


@pytest.mark.asyncio
async def test_can_remove_type_from_user_type(node_service, system_type_ids):
    """Test that removing 'type' from a user-created type node works."""
    service = node_service
    type_type_id = system_type_ids['type']
    
    # Create a user-defined type (page with 'type' type)
    user_type = await service.create_page("MyCustomType", additional_types=[type_type_id])
    
    # Remove 'type' from user type - should succeed (no exception, user types are not protected)
    success = await service.remove_type(user_type.id, type_type_id)
    # May return True or False depending on whether the type was actually set,
    # but importantly it should NOT raise SystemTypeConstraintError
    assert isinstance(success, bool)


@pytest.mark.asyncio
async def test_adding_type_type_sets_is_type_flag(node_service, system_type_ids):
    """Test that adding 'type' type to a page sets is_type=True on the node."""
    service = node_service
    type_type_id = system_type_ids['type']
    
    # Create a page (not a type initially)
    page = await service.create_page("Test Page For Type")
    
    # Verify is_type is False initially
    node = await service.get_node(page.id)
    assert node is not None
    assert node.is_type is False
    
    # Add 'type' type to the page
    success = await service.add_type(page.id, type_type_id)
    assert success is True
    
    # Verify is_type is now True
    node = await service.get_node(page.id)
    assert node is not None
    assert node.is_type is True


@pytest.mark.asyncio
async def test_removing_type_type_clears_is_type_flag(node_service, system_type_ids):
    """Test that removing 'type' type from a user-created type sets is_type=False."""
    service = node_service
    type_type_id = system_type_ids['type']
    
    # Create a page and add 'type' type to make it a type
    page = await service.create_page("User Created Type")
    await service.add_type(page.id, type_type_id)
    
    # Verify is_type is True
    node = await service.get_node(page.id)
    assert node is not None
    assert node.is_type is True
    
    # Remove 'type' type
    success = await service.remove_type(page.id, type_type_id)
    assert success is True
    
    # Verify is_type is now False
    node = await service.get_node(page.id)
    assert node is not None
    assert node.is_type is False


@pytest.mark.asyncio
async def test_page_type_sets_is_page_flag(node_service, system_type_ids):
    """Test that adding/removing 'page' type sets is_page flag correctly."""
    service = node_service
    page_type_id = system_type_ids['page']
    
    # Create a block (not a page initially)
    parent = await service.create_page("Parent Page")
    block = await service.create_block("Test Block", parent.id)
    
    # Verify is_page is False initially
    node = await service.get_node(block.id)
    assert node is not None
    assert node.is_page is False
    
    # Add 'page' type to the block
    success = await service.add_type(block.id, page_type_id)
    assert success is True
    
    # Verify is_page is now True
    node = await service.get_node(block.id)
    assert node is not None
    assert node.is_page is True
    
    # Remove 'page' type
    success = await service.remove_type(block.id, page_type_id)
    assert success is True
    
    # Verify is_page is now False
    node = await service.get_node(block.id)
    assert node is not None
    assert node.is_page is False
