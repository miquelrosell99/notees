"""Tests for linked references feature following the new specification.

Key semantics:
1. Text links: source_block_id = T (block containing link), property_id = NULL
2. Property links: source_node_id = B (property owner), property_id = set
3. System property `types` is EXCLUDED from backlinks entirely
4. Types Path: separate mechanism for inherited types (for queries, not backlinks)
5. Breadcrumbs include property provenance: T → property_name → B → … → page
6. Recursive child references: Links to children show on parent's linked references
"""
import json

import pytest
import pytest_asyncio

from app.db.schema import SYSTEM_CLASS_UUIDS


@pytest_asyncio.fixture(scope="function")
async def link_service_fixtures(db_pool, test_user):
    """Create repositories and link service for testing."""
    from app.features.nodes.link_service import LinkParsingService
    from app.features.nodes.repository import PostgresLinkRepository, PostgresNodeRepository
    from app.features.properties.repository import PostgresPropertyRepository

    workspace_id = test_user["workspace_id"]

    # Get system IDs
    async with db_pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT id FROM node WHERE uuid = $1 AND workspace_id = $2",
            SYSTEM_CLASS_UUIDS['page'], workspace_id
        )
        page_type_id = row['id']

    # Create repositories (classes now in class_ids column, no property)
    node_repo = PostgresNodeRepository(db_pool, workspace_id, page_type_id)
    property_repo = PostgresPropertyRepository(db_pool, workspace_id)
    link_repo = PostgresLinkRepository(db_pool, workspace_id)

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
        'workspace_id': workspace_id,
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
        assert len(columns) == 1, 'classes_path not in node columns'

        # Check node_link table has property_id column
        columns = await conn.fetch("""
            SELECT column_name FROM information_schema.columns
            WHERE table_name = 'node_link' AND column_name = 'property_id'
        """)
        assert len(columns) == 1, 'property_id not in node_link columns'


@pytest.mark.asyncio
async def test_text_link_creates_backlink(link_service_fixtures):
    """Test that text links create backlinks with source as the linking block."""
    from app.domain.entities import NodeCreateData

    node_repo = link_service_fixtures['node_repo']
    link_service = link_service_fixtures['link_service']

    # Create target page X
    page_x = await node_repo.create(NodeCreateData(name='Page X'))
    assert page_x.id is not None

    # Create source page with a block T that links to X
    page_source = await node_repo.create(NodeCreateData(name='Source Page'))
    assert page_source.id is not None

    block_t = await node_repo.create(NodeCreateData(
        name=json.dumps([{"type": "paragraph", "children": [
            {"type": "text", "text": "Block linking to "},
            {"type": "node_link", "ref_type": "node", "link_id": page_x.uuid}
        ]}]),
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
    class_node = await node_repo.create(NodeCreateData(name='Task'))
    assert class_node.id is not None

    # Create a page that has this class
    page = await node_repo.create(NodeCreateData(name='My Task'))
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

    node_repo = link_service_fixtures['node_repo']
    link_service = link_service_fixtures['link_service']

    # Create two class nodes
    class_task = await node_repo.create(NodeCreateData(name='Task'))
    class_meeting = await node_repo.create(NodeCreateData(name='Meeting'))
    assert class_task.id is not None
    assert class_meeting.id is not None

    # Create a page with class Task
    page = await node_repo.create(NodeCreateData(name='Parent Page'))
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
    target = await node_repo.create(NodeCreateData(name='Target'))
    assert target.id is not None

    # Create source page with nested blocks
    source_page = await node_repo.create(NodeCreateData(name='Source Page'))
    assert source_page.id is not None

    block1 = await node_repo.create(NodeCreateData(name='Block 1', parent_id=source_page.id))
    assert block1.id is not None

    block2 = await node_repo.create(NodeCreateData(
        name=json.dumps([{"type": "paragraph", "children": [
            {"type": "text", "text": "Deep block linking to "},
            {"type": "node_link", "ref_type": "node", "link_id": target.uuid}
        ]}]),
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
    page = await node_repo.create(NodeCreateData(name='Page with no links'))
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


@pytest.mark.asyncio
async def test_recursive_child_references(link_service_fixtures):
    """Test that references to child pages appear in parent's linked references recursively.

    Scenario:
    - Parent Page
      - Child Page
        - Grandchild Page
    - Another Page links to Grandchild Page

    Expected: Link to Grandchild should appear in Parent's linked references.
    """
    from app.domain.entities import NodeCreateData

    node_repo = link_service_fixtures['node_repo']
    link_service = link_service_fixtures['link_service']

    # Create parent page
    parent = await node_repo.create(NodeCreateData(name='Parent Page'))
    assert parent.id is not None

    # Create child page (child of parent)
    child = await node_repo.create(NodeCreateData(name='Child Page', parent_id=parent.id))
    assert child.id is not None

    # Create grandchild page (child of child)
    grandchild = await node_repo.create(NodeCreateData(name='Grandchild Page', parent_id=child.id))
    assert grandchild.id is not None

    # Create another page that links to the grandchild
    linking_page = await node_repo.create(NodeCreateData(name='Another Page'))
    assert linking_page.id is not None

    # Create a block in the linking page that references the grandchild
    linking_block = await node_repo.create(NodeCreateData(
        name=json.dumps([{"type": "paragraph", "children": [
            {"type": "text", "text": "This links to "},
            {"type": "node_link", "ref_type": "node", "link_id": grandchild.uuid}
        ]}]),
        parent_id=linking_page.id
    ))
    assert linking_block.id is not None

    # Update links
    await link_service.update_node_links(linking_block.id, linking_block.name)

    # Test 1: Grandchild should have 1 backlink
    grandchild_backlinks = await link_service.get_backlinks(grandchild.id)
    assert len(grandchild_backlinks) == 1, f'Expected 1 backlink to grandchild, got {len(grandchild_backlinks)}'
    assert grandchild_backlinks[0].source_node_id == linking_block.id

    # Test 2: Child should also see the link to its descendant (grandchild)
    child_backlinks = await link_service.get_backlinks(child.id)
    assert len(child_backlinks) == 1, f'Expected 1 backlink to child (via grandchild), got {len(child_backlinks)}'
    assert child_backlinks[0].source_node_id == linking_block.id

    # Test 3: Parent should also see the link to its descendant (grandchild)
    parent_backlinks = await link_service.get_backlinks(parent.id)
    assert len(parent_backlinks) == 1, f'Expected 1 backlink to parent (via grandchild), got {len(parent_backlinks)}'
    assert parent_backlinks[0].source_node_id == linking_block.id

    # Test 4: Create another link to the child (not grandchild)
    another_linking_page = await node_repo.create(NodeCreateData(name='Yet Another Page'))
    assert another_linking_page.id is not None

    another_linking_block = await node_repo.create(NodeCreateData(
        name=json.dumps([{"type": "paragraph", "children": [
            {"type": "text", "text": "This links to "},
            {"type": "node_link", "ref_type": "node", "link_id": child.uuid}
        ]}]),
        parent_id=another_linking_page.id
    ))
    assert another_linking_block.id is not None

    await link_service.update_node_links(another_linking_block.id, another_linking_block.name)

    # Parent should now have 2 backlinks: one to grandchild, one to child
    parent_backlinks_updated = await link_service.get_backlinks(parent.id)
    assert len(parent_backlinks_updated) == 2, f'Expected 2 backlinks to parent, got {len(parent_backlinks_updated)}'

    # Child should have 2 backlinks: one to itself, one to grandchild
    child_backlinks_updated = await link_service.get_backlinks(child.id)
    assert len(child_backlinks_updated) == 2, f'Expected 2 backlinks to child, got {len(child_backlinks_updated)}'

    # Grandchild should still have 1 backlink (only the direct link)
    grandchild_backlinks_updated = await link_service.get_backlinks(grandchild.id)
    assert len(grandchild_backlinks_updated) == 1, f'Expected 1 backlink to grandchild, got {len(grandchild_backlinks_updated)}'



@pytest.mark.integration
@pytest.mark.asyncio
async def test_linked_references_dedup_self_and_child_links(auth_client, link_service_fixtures):
    """A block linking to both the current page and a child page should appear once.

    Regression: blocks mentioning both the target page and one of its descendants
    produced two linked-reference entries because get_backlinks() includes links to
    descendants and get_linked_references() did not deduplicate by source node.
    """
    from app.domain.entities import NodeCreateData

    node_repo = link_service_fixtures['node_repo']
    link_service = link_service_fixtures['link_service']

    # Create Colombia page
    colombia = await node_repo.create(NodeCreateData(name='Colombia'))
    assert colombia.id is not None

    # Create Bogotá child page under Colombia
    bogota = await node_repo.create(NodeCreateData(name='Bogotá', parent_id=colombia.id))
    assert bogota.id is not None

    # Create a block under Colombia that links to both Colombia and Bogotá
    block = await node_repo.create(NodeCreateData(
        name=json.dumps([{"type": "paragraph", "children": [
            {"type": "text", "text": "La capital de "},
            {"type": "node_link", "ref_type": "node", "link_id": colombia.uuid},
            {"type": "text", "text": " es "},
            {"type": "node_link", "ref_type": "node", "link_id": bogota.uuid},
        ]}]),
        parent_id=colombia.id,
    ))
    assert block.id is not None

    # Update links so node_link records are created
    await link_service.update_node_links(block.id, block.name)

    # Verify get_backlinks returns 2 (one for Colombia, one for Bogotá)
    colombia_backlinks = await link_service.get_backlinks(colombia.id)
    assert len(colombia_backlinks) == 2, f'Expected 2 backlinks to Colombia, got {len(colombia_backlinks)}'

    # But the linked-references endpoint should deduplicate and return 1
    response = await auth_client.get(f"/api/nodes/{colombia.id}/linked-references")
    assert response.status_code == 200
    data = response.json()
    linked_refs = data.get("linked_references", [])
    assert len(linked_refs) == 1, f'Expected 1 linked reference, got {len(linked_refs)}'
    assert linked_refs[0]["source_node"]["id"] == block.id


@pytest.mark.integration
@pytest.mark.asyncio
async def test_linked_references_dedup_child_of_source(auth_client, link_service_fixtures):
    """A child block linking to the target should not appear separately when its parent also links.

    If Block A links to Target and Block B (child of A) also links to Target,
    Block B should appear only as a child under Block A, not as a separate entry.
    """
    from app.domain.entities import NodeCreateData

    node_repo = link_service_fixtures['node_repo']
    link_service = link_service_fixtures['link_service']

    # Create target page
    target = await node_repo.create(NodeCreateData(name='Target Page'))
    assert target.id is not None

    # Create source page
    source_page = await node_repo.create(NodeCreateData(name='Source Page'))
    assert source_page.id is not None

    # Create parent block that links to target
    parent_block = await node_repo.create(NodeCreateData(
        name=json.dumps([{"type": "paragraph", "children": [
            {"type": "text", "text": "Parent linking to "},
            {"type": "node_link", "ref_type": "node", "link_id": target.uuid}
        ]}]),
        parent_id=source_page.id,
    ))
    assert parent_block.id is not None

    # Create child block under parent that also links to target
    child_block = await node_repo.create(NodeCreateData(
        name=json.dumps([{"type": "paragraph", "children": [
            {"type": "text", "text": "Child linking to "},
            {"type": "node_link", "ref_type": "node", "link_id": target.uuid}
        ]}]),
        parent_id=parent_block.id,
    ))
    assert child_block.id is not None

    # Update links
    await link_service.update_node_links(parent_block.id, parent_block.name)
    await link_service.update_node_links(child_block.id, child_block.name)

    # get_backlinks should return 2 (one for parent, one for child)
    backlinks = await link_service.get_backlinks(target.id)
    assert len(backlinks) == 2, f'Expected 2 backlinks, got {len(backlinks)}'

    # linked-references endpoint should return 1 top-level entry (parent) with child nested
    response = await auth_client.get(f"/api/nodes/{target.id}/linked-references")
    assert response.status_code == 200
    data = response.json()
    linked_refs = data.get("linked_references", [])
    assert len(linked_refs) == 1, f'Expected 1 top-level linked reference, got {len(linked_refs)}'
    assert linked_refs[0]["source_node"]["id"] == parent_block.id

    # Child should be nested under parent
    children = linked_refs[0]["source_node"].get("children", [])
    child_ids = [c["id"] for c in children]
    assert child_block.id in child_ids, f'Child block should be nested under parent, got children: {child_ids}'



@pytest.mark.asyncio
async def test_embed_link_creates_backlink(link_service_fixtures):
    """Test that embed references (ref_type='embed') are persisted and surfaced as backlinks."""
    from app.domain.entities import NodeCreateData

    node_repo = link_service_fixtures['node_repo']
    link_service = link_service_fixtures['link_service']

    # Create target page X
    page_x = await node_repo.create(NodeCreateData(name='Embed Target'))
    assert page_x.id is not None

    # Create source page with a block T that embeds X
    page_source = await node_repo.create(NodeCreateData(name='Source Page'))
    assert page_source.id is not None

    block_t = await node_repo.create(NodeCreateData(
        name=json.dumps([{"type": "paragraph", "children": [
            {"type": "node_link", "ref_type": "embed", "link_id": page_x.uuid}
        ]}]),
        parent_id=page_source.id
    ))
    assert block_t.id is not None

    # Update links for block T
    await link_service.update_node_links(block_t.id, block_t.name)

    # Get backlinks to page X
    backlinks = await link_service.get_backlinks(page_x.id)
    embed_backlinks = [b for b in backlinks if b.link.is_embed]

    assert len(embed_backlinks) == 1, f'Expected 1 embed backlink, got {len(embed_backlinks)}'
    assert embed_backlinks[0].source_node_id == block_t.id
    assert embed_backlinks[0].property_id is None
