"""Tests for linked references feature following the new specification.

Key semantics:
1. Text links: source_block_id = T (block containing link), property_id = NULL
2. Property links: source_node_id = B (property owner), property_id = set
3. System property `types` is EXCLUDED from backlinks entirely
4. Types Path: separate mechanism for inherited types (for queries, not backlinks)
5. Breadcrumbs include property provenance: T → property_name → B → … → page
"""
import pytest
from datetime import datetime, timezone

from app.db.schema import SYSTEM_CLASS_UUIDS, SYSTEM_PROPERTY_UUIDS


@pytest.fixture
async def link_service_fixtures(db_pool, test_user):
    """Create repositories and link service for testing."""
    from app.domain.repositories import (
        PostgresNodeRepository,
        PostgresPropertyRepository,
        PostgresLinkRepository,
    )
    from app.domain.services import LinkParsingService
    
    graph_id = test_user["graph_id"]
    
    # Get system IDs
    async with db_pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT id FROM node WHERE uuid = $1 AND graph_id = $2",
            SYSTEM_CLASS_UUIDS['page'], graph_id
        )
        page_type_id = row['id']
    
    # Create repositories (classes now in class_ids column, no property)
    node_repo = PostgresNodeRepository(db_pool, graph_id, page_type_id)
    property_repo = PostgresPropertyRepository(db_pool, graph_id)
    link_repo = PostgresLinkRepository(db_pool, graph_id)
    
    # Create link service
    link_service = LinkParsingService(
        node_repo, link_repo, property_repo
    )
    
    return {
        'node_repo': node_repo,
        'property_repo': property_repo,
        'link_repo': link_repo,
        'link_service': link_service,
        'page_type_id': page_type_id,
        'graph_id': graph_id,
    }



@pytest.mark.asyncio
async def test_schema_columns_exist(db_pool):
    """Test that new schema columns exist."""
    async with db_pool.acquire() as conn:
        # Check node table has classes_path column
        columns = await conn.fetch("""
            SELECT column_name FROM information_schema.columns 
            WHERE table_name = 'node' AND column_name = 'classes_path'
        """)
        assert len(columns) == 1, f'classes_path not in node columns'
        
        # Check node_link table has property_id column
        columns = await conn.fetch("""
            SELECT column_name FROM information_schema.columns 
            WHERE table_name = 'node_link' AND column_name = 'property_id'
        """)
        assert len(columns) == 1, f'property_id not in node_link columns'


@pytest.mark.asyncio
async def test_text_link_creates_backlink(link_service_fixtures):
    """Test that text links create backlinks with source as the linking block."""
    from app.domain.entities import NodeCreateData
    
    node_repo = link_service_fixtures['node_repo']
    link_service = link_service_fixtures['link_service']
    
    # Create target page X
    page_x = await node_repo.create(NodeCreateData(name='Page X', is_page=True))
    assert page_x.id is not None
    
    # Create source page with a block T that links to X
    page_source = await node_repo.create(NodeCreateData(name='Source Page', is_page=True))
    assert page_source.id is not None
    
    block_t = await node_repo.create(NodeCreateData(
        name=f'Block linking to [[{page_x.uuid}]]',
        parent_id=page_source.id
    ))
    assert block_t.id is not None
    
    # Update links for block T
    await link_service.update_node_links(block_t.id, block_t.name)
    
    # Get backlinks to page X
    backlinks = await link_service.get_backlinks(page_x.id)
    
    # Should have one backlink
    assert len(backlinks) == 1, f'Expected 1 backlink, got {len(backlinks)}'
    
    # Source should be block T, not the property owner
    assert backlinks[0].source_node_id == block_t.id
    assert backlinks[0].property_id is None  # Text link, not property link


@pytest.mark.asyncio
async def test_classes_property_excluded_from_backlinks(db_pool, link_service_fixtures):
    """Test that classes stored in class_ids column do not create backlinks."""
    from app.domain.entities import NodeCreateData
    
    node_repo = link_service_fixtures['node_repo']
    link_service = link_service_fixtures['link_service']
    
    # Create a class node
    class_node = await node_repo.create(NodeCreateData(name='Task', is_class=True))
    assert class_node.id is not None
    
    # Create a page that has this class
    page = await node_repo.create(NodeCreateData(name='My Task', is_page=True))
    assert page.id is not None
    
    # Add class directly to class_ids column (no longer using property links)
    async with db_pool.acquire() as conn:
        await conn.execute(
            'UPDATE node SET class_ids = $1 WHERE id = $2',
            [class_node.id], page.id
        )
    
    # Get backlinks to the class node
    backlinks = await link_service.get_backlinks(class_node.id)
    
    # Should have NO backlinks because classes are now in class_ids column, not property links
    assert len(backlinks) == 0, f'Expected 0 backlinks (classes in column, not property), got {len(backlinks)}'



@pytest.mark.asyncio
async def test_classes_path_inheritance(db_pool, link_service_fixtures):
    """Test that classes_path accumulates classes from ancestors."""
    from app.domain.entities import NodeCreateData
    from datetime import datetime, timezone
    
    node_repo = link_service_fixtures['node_repo']
    link_service = link_service_fixtures['link_service']
    graph_id = link_service_fixtures['graph_id']
    
    # Create two class nodes
    class_task = await node_repo.create(NodeCreateData(name='Task', is_class=True))
    class_meeting = await node_repo.create(NodeCreateData(name='Meeting', is_class=True))
    assert class_task.id is not None
    assert class_meeting.id is not None
    
    # Create a page with class Task
    page = await node_repo.create(NodeCreateData(name='Parent Page', is_page=True))
    assert page.id is not None
    
    # Set page class directly in class_ids column (no longer using property_value_relation)
    async with db_pool.acquire() as conn:
        await conn.execute(
            'UPDATE node SET class_ids = $1 WHERE id = $2',
            [class_task.id], page.id
        )
    
    # Create a child block
    block = await node_repo.create(NodeCreateData(name='Child Block', parent_id=page.id))
    assert block.id is not None
    
    # Update classes_path for the block
    classes_path = await link_service.update_classes_path(block.id)
    
    # Block should inherit Task class from parent
    assert class_task.id in classes_path, f'Expected class_task.id in classes_path: {classes_path}'



@pytest.mark.asyncio
async def test_backlinks_include_breadcrumb_path(link_service_fixtures):
    """Test that backlinks include breadcrumb path to page."""
    from app.domain.entities import NodeCreateData
    
    node_repo = link_service_fixtures['node_repo']
    link_service = link_service_fixtures['link_service']
    
    # Create target page
    target = await node_repo.create(NodeCreateData(name='Target', is_page=True))
    assert target.id is not None
    
    # Create source page with nested blocks
    source_page = await node_repo.create(NodeCreateData(name='Source Page', is_page=True))
    assert source_page.id is not None
    
    block1 = await node_repo.create(NodeCreateData(name='Block 1', parent_id=source_page.id))
    assert block1.id is not None
    
    block2 = await node_repo.create(NodeCreateData(
        name=f'Deep block linking to [[{target.uuid}]]', 
        parent_id=block1.id
    ))
    assert block2.id is not None
    
    # Update links
    await link_service.update_node_links(block2.id, block2.name)
    
    # Get backlinks
    backlinks = await link_service.get_backlinks(target.id)
    
    assert len(backlinks) == 1
    
    # Breadcrumb should go from block2 → block1 → source_page
    breadcrumb = backlinks[0].breadcrumb_path
    assert len(breadcrumb) >= 2, f'Expected at least 2 breadcrumb segments, got {len(breadcrumb)}'
    
    # First segment should be the source block (block2)
    assert breadcrumb[0][0] == block2.id


@pytest.mark.asyncio
async def test_no_links_results_in_empty(link_service_fixtures):
    """Test that nodes with no links have empty classes_path and no backlinks."""
    from app.domain.entities import NodeCreateData
    
    node_repo = link_service_fixtures['node_repo']
    link_service = link_service_fixtures['link_service']
    
    # Create a page with no links
    page = await node_repo.create(NodeCreateData(name='Page with no links', is_page=True))
    assert page.id is not None
    
    # Create a block with no links
    block = await node_repo.create(NodeCreateData(name='Block with no links', parent_id=page.id))
    assert block.id is not None
    
    await link_service.update_node_links(block.id, block.name)
    
    # Refetch block
    block_updated = await node_repo.get_by_id(block.id)
    assert block_updated is not None
    
    # classes_path should be empty (no types set on ancestors)
    assert block_updated.classes_path == []
    
    # No backlinks to the page
    backlinks = await link_service.get_backlinks(page.id)
    assert len(backlinks) == 0

