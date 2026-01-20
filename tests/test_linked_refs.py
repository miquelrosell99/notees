"""Tests for linked references feature following the new specification.

Key semantics:
1. Text links: source_block_id = T (block containing link), property_id = NULL
2. Property links: source_node_id = B (property owner), property_id = set
3. System property `types` is EXCLUDED from backlinks entirely
4. Types Path: separate mechanism for inherited types (for queries, not backlinks)
5. Breadcrumbs include property provenance: T → property_name → B → … → page
"""
import pytest
import tempfile
from pathlib import Path

import aiosqlite


@pytest.fixture
async def test_db():
    """Create a test database."""
    with tempfile.TemporaryDirectory() as tmpdir:
        db_path = Path(tmpdir) / 'test.db'
        
        from app.db.schema import init_database
        conn = await init_database(db_path)
        
        yield conn
        
        await conn.close()


@pytest.mark.asyncio
async def test_schema_columns_exist(test_db):
    """Test that new schema columns exist."""
    conn = test_db
    
    # Check node table has types_path column
    cursor = await conn.execute("PRAGMA table_info(node)")
    columns = [row['name'] for row in await cursor.fetchall()]
    assert 'types_path' in columns, f'types_path not in node columns: {columns}'
    
    # Check node_link table has property_id column
    cursor = await conn.execute("PRAGMA table_info(node_link)")
    columns = [row['name'] for row in await cursor.fetchall()]
    assert 'property_id' in columns, f'property_id not in node_link columns: {columns}'


@pytest.mark.asyncio
async def test_text_link_creates_backlink(test_db):
    """Test that text links create backlinks with source as the linking block."""
    conn = test_db
    
    from app.domain.entities import NodeCreateData
    from app.domain.repositories import SQLiteNodeRepository, SQLiteLinkRepository
    from app.domain.services import LinkParsingService
    
    # Get system IDs
    cursor = await conn.execute("SELECT id FROM node WHERE name = 'page' AND is_type = 1 LIMIT 1")
    row = await cursor.fetchone()
    page_type_id = row['id']
    
    cursor = await conn.execute("SELECT id FROM property WHERE name = 'types' LIMIT 1")
    row = await cursor.fetchone()
    types_property_id = row['id']
    
    # Create repos and services
    node_repo = SQLiteNodeRepository(conn, page_type_id, types_property_id)
    link_repo = SQLiteLinkRepository(conn)
    link_service = LinkParsingService(node_repo, link_repo, types_property_id=types_property_id)
    
    # Create target page X
    page_x = await node_repo.create(NodeCreateData(name='Page X', is_page=True))
    assert page_x.id is not None
    
    # Create source page with a block T that links to X
    page_source = await node_repo.create(NodeCreateData(name='Source Page', is_page=True))
    assert page_source.id is not None
    
    block_t = await node_repo.create(NodeCreateData(
        name=f'Block linking to [[{page_x.id}]]',
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
async def test_types_property_excluded_from_backlinks(test_db):
    """Test that the system `types` property is excluded from backlinks."""
    conn = test_db
    
    from app.domain.entities import NodeCreateData
    from app.domain.repositories import SQLiteNodeRepository, SQLiteLinkRepository, SQLitePropertyRepository
    from app.domain.services import LinkParsingService
    
    # Get system IDs
    cursor = await conn.execute("SELECT id FROM node WHERE name = 'page' AND is_type = 1 LIMIT 1")
    row = await cursor.fetchone()
    page_type_id = row['id']
    
    cursor = await conn.execute("SELECT id FROM property WHERE name = 'types' LIMIT 1")
    row = await cursor.fetchone()
    types_property_id = row['id']
    
    # Create repos and services
    node_repo = SQLiteNodeRepository(conn, page_type_id, types_property_id)
    link_repo = SQLiteLinkRepository(conn)
    property_repo = SQLitePropertyRepository(conn)
    link_service = LinkParsingService(
        node_repo, link_repo, property_repo, types_property_id=types_property_id
    )
    
    # Create a type node
    type_node = await node_repo.create(NodeCreateData(name='Task', is_type=True))
    assert type_node.id is not None
    
    # Create a page that has this type
    page = await node_repo.create(NodeCreateData(name='My Task', is_page=True))
    assert page.id is not None
    
    # Add type via property link - this simulates setting types property
    await link_service.update_property_links(page.id, types_property_id, [type_node.id])
    
    # Get backlinks to the type node
    backlinks = await link_service.get_backlinks(type_node.id)
    
    # Should have NO backlinks because types property is excluded
    assert len(backlinks) == 0, f'Expected 0 backlinks (types excluded), got {len(backlinks)}'


@pytest.mark.asyncio
async def test_types_path_inheritance(test_db):
    """Test that types_path accumulates types from ancestors."""
    conn = test_db
    
    from app.domain.entities import NodeCreateData
    from app.domain.repositories import SQLiteNodeRepository, SQLiteLinkRepository
    from app.domain.services import LinkParsingService
    from datetime import datetime, timezone
    
    # Get system IDs
    cursor = await conn.execute("SELECT id FROM node WHERE name = 'page' AND is_type = 1 LIMIT 1")
    row = await cursor.fetchone()
    page_type_id = row['id']
    
    cursor = await conn.execute("SELECT id FROM property WHERE name = 'types' LIMIT 1")
    row = await cursor.fetchone()
    types_property_id = row['id']
    
    # Create repos and services
    node_repo = SQLiteNodeRepository(conn, page_type_id, types_property_id)
    link_repo = SQLiteLinkRepository(conn)
    link_service = LinkParsingService(node_repo, link_repo, types_property_id=types_property_id)
    
    # Create two type nodes
    type_task = await node_repo.create(NodeCreateData(name='Task', is_type=True))
    type_meeting = await node_repo.create(NodeCreateData(name='Meeting', is_type=True))
    assert type_task.id is not None
    assert type_meeting.id is not None
    
    # Create a page with type Task
    page = await node_repo.create(NodeCreateData(name='Parent Page', is_page=True))
    assert page.id is not None
    
    now = datetime.now(timezone.utc).isoformat()
    
    # First create a node_property entry for the types property on the page
    cursor = await conn.execute(
        '''INSERT INTO node_property (node_id, property_id, create_date, write_date)
           VALUES (?, ?, ?, ?)''',
        (page.id, types_property_id, now, now)
    )
    node_property_id = cursor.lastrowid
    await conn.commit()
    
    # Set page type via property_value_relation (simulating types property)
    await conn.execute(
        '''INSERT INTO property_value_relation 
           (node_property_id, property_id, node_id, target_node_id, "order", create_date, write_date) 
           VALUES (?, ?, ?, ?, ?, ?, ?)''',
        (node_property_id, types_property_id, page.id, type_task.id, 0, now, now)
    )
    await conn.commit()
    
    # Create a child block
    block = await node_repo.create(NodeCreateData(name='Child Block', parent_id=page.id))
    assert block.id is not None
    
    # Update types_path for the block
    types_path = await link_service.update_types_path(block.id)
    
    # Block should inherit Task type from parent
    assert type_task.id in types_path, f'Expected type_task.id in types_path: {types_path}'


@pytest.mark.asyncio
async def test_backlinks_include_breadcrumb_path(test_db):
    """Test that backlinks include breadcrumb path to page."""
    conn = test_db
    
    from app.domain.entities import NodeCreateData
    from app.domain.repositories import SQLiteNodeRepository, SQLiteLinkRepository
    from app.domain.services import LinkParsingService
    
    # Get system IDs
    cursor = await conn.execute("SELECT id FROM node WHERE name = 'page' AND is_type = 1 LIMIT 1")
    row = await cursor.fetchone()
    page_type_id = row['id']
    
    cursor = await conn.execute("SELECT id FROM property WHERE name = 'types' LIMIT 1")
    row = await cursor.fetchone()
    types_property_id = row['id']
    
    # Create repos and services
    node_repo = SQLiteNodeRepository(conn, page_type_id, types_property_id)
    link_repo = SQLiteLinkRepository(conn)
    link_service = LinkParsingService(node_repo, link_repo, types_property_id=types_property_id)
    
    # Create target page
    target = await node_repo.create(NodeCreateData(name='Target', is_page=True))
    assert target.id is not None
    
    # Create source page with nested blocks
    source_page = await node_repo.create(NodeCreateData(name='Source Page', is_page=True))
    assert source_page.id is not None
    
    block1 = await node_repo.create(NodeCreateData(name='Block 1', parent_id=source_page.id))
    assert block1.id is not None
    
    block2 = await node_repo.create(NodeCreateData(
        name=f'Deep block linking to [[{target.id}]]', 
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
async def test_no_links_results_in_empty(test_db):
    """Test that nodes with no links have empty types_path and no backlinks."""
    conn = test_db
    
    from app.domain.entities import NodeCreateData
    from app.domain.repositories import SQLiteNodeRepository, SQLiteLinkRepository
    from app.domain.services import LinkParsingService
    
    # Get system IDs
    cursor = await conn.execute("SELECT id FROM node WHERE name = 'page' AND is_type = 1 LIMIT 1")
    row = await cursor.fetchone()
    page_type_id = row['id']
    
    cursor = await conn.execute("SELECT id FROM property WHERE name = 'types' LIMIT 1")
    row = await cursor.fetchone()
    types_property_id = row['id']
    
    # Create repos and services
    node_repo = SQLiteNodeRepository(conn, page_type_id, types_property_id)
    link_repo = SQLiteLinkRepository(conn)
    link_service = LinkParsingService(node_repo, link_repo, types_property_id=types_property_id)
    
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
    
    # types_path should be empty (no types set on ancestors)
    assert block_updated.types_path == []
    
    # No backlinks to the page
    backlinks = await link_service.get_backlinks(page.id)
    assert len(backlinks) == 0
