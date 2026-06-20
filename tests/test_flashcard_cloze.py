"""Tests for cloze class constraints.

Cloze deletions are only valid as direct children of card nodes.
"""
import pytest
import pytest_asyncio

from app.db.schema import SYSTEM_CLASS_UUIDS
from app.domain.errors import SystemClassConstraintError


@pytest_asyncio.fixture
async def node_service(db_pool, test_user):
    """Create a NodeService for testing."""
    from app.features.nodes.link_service import LinkParsingService
    from app.features.nodes.node_service import NodeService
    from app.features.nodes.repository import (
        PostgresLinkRepository,
        PostgresNodeRepository,
        PostgresNodeViewRepository,
    )
    from app.features.properties.repository import PostgresPropertyRepository

    workspace_id = test_user["workspace_id"]

    async with db_pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT id FROM node WHERE uuid = $1 AND workspace_id = $2",
            SYSTEM_CLASS_UUIDS['page'], workspace_id
        )
        page_type_id = row['id']

    node_repo = PostgresNodeRepository(db_pool, workspace_id, page_type_id)
    property_repo = PostgresPropertyRepository(db_pool, workspace_id)
    link_repo = PostgresLinkRepository(db_pool, workspace_id)
    view_repo = PostgresNodeViewRepository(db_pool, workspace_id, str(test_user["id"]))

    link_service = LinkParsingService(node_repo, link_repo)
    service = NodeService(
        node_repo, property_repo, link_service, page_type_id,
        workspace_id=workspace_id,
        view_repo=view_repo,
    )

    return service


@pytest_asyncio.fixture
async def class_ids(db_pool, test_user, node_service):
    """Get relevant system class IDs for the test workspace."""
    workspace_id = test_user["workspace_id"]
    ids = {}
    async with db_pool.acquire() as conn:
        for name in ['card', 'cloze']:
            row = await conn.fetchrow(
                "SELECT id FROM node WHERE uuid = $1 AND workspace_id = $2",
                SYSTEM_CLASS_UUIDS[name], workspace_id
            )
            ids[name] = row['id'] if row else None
    return ids


@pytest.mark.asyncio
async def test_cannot_add_cloze_to_block_without_card_parent(node_service, class_ids):
    """Cloze class requires the block's parent to be a card."""
    page = await node_service.create_page("Test Page")
    block = await node_service.create_block("Block", page.id)

    with pytest.raises(SystemClassConstraintError) as exc_info:
        await node_service.add_class(block.id, class_ids['cloze'])

    assert "cloze" in exc_info.value.message.lower()


@pytest.mark.asyncio
async def test_can_add_cloze_to_block_inside_card(node_service, class_ids):
    """Cloze class succeeds when the block is a direct child of a card."""
    page = await node_service.create_page("Test Page")
    card = await node_service.create_block("Card", page.id)
    await node_service.add_class(card.id, class_ids['card'])

    cloze = await node_service.create_block("Cloze", card.id)
    success = await node_service.add_class(cloze.id, class_ids['cloze'])

    assert success is True
    updated = await node_service.get_node(cloze.id)
    assert updated.is_cloze is True


@pytest.mark.asyncio
async def test_moving_cloze_out_of_card_strips_cloze_class(node_service, class_ids):
    """Moving a cloze block under a non-card parent removes the cloze class."""
    page = await node_service.create_page("Test Page")
    card = await node_service.create_block("Card", page.id)
    await node_service.add_class(card.id, class_ids['card'])

    cloze = await node_service.create_block("Cloze", card.id)
    await node_service.add_class(cloze.id, class_ids['cloze'])

    moved = await node_service.move_node(cloze.id, page.id, 0)
    assert moved is not None
    assert moved.is_cloze is False
