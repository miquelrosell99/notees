"""Tests for tag storage in node.tag_ids using in-memory fakes."""

import pytest

from app.domain.entities import Node, NodeCreateData
from app.domain.entities.constants import SYSTEM_CLASS_UUIDS
from app.features.nodes.node_service import NodeService
from tests.fakes import (
    FakeClassExtendRepository,
    FakeLinkParsingService,
    FakeNodeRepository,
    FakePropertyRepository,
)

pytestmark = pytest.mark.unit


@pytest.fixture
def node_service():
    """Build a NodeService backed by in-memory fakes."""
    node_repo = FakeNodeRepository()
    page_class = node_repo.add_node(
        Node(uuid=SYSTEM_CLASS_UUIDS["page"], name="Page", is_page=True)
    )
    property_repo = FakePropertyRepository()
    link_service = FakeLinkParsingService()
    class_extend_repo = FakeClassExtendRepository()
    return NodeService(
        node_repo,
        property_repo,
        link_service,
        page_class_id=page_class.id,
        workspace_id=1,
        class_extend_repo=class_extend_repo,
    )


@pytest.mark.asyncio
async def test_create_node_with_tags(node_service):
    """Creating a node with tags stores them in node.tag_ids."""
    tag1 = await node_service.create_page("Tag One")
    tag2 = await node_service.create_page("Tag Two")

    node = await node_service.create_node(
        NodeCreateData(name="Tagged node", tags=[tag1.id, tag2.id]),
        user_id=None,
    )

    assert node.tag_ids == [tag1.id, tag2.id]

    fetched = await node_service.get_node(node.id)
    assert fetched.tag_ids == [tag1.id, tag2.id]


@pytest.mark.asyncio
async def test_add_tag_link_updates_tag_ids(node_service):
    """add_tag_link appends the target to node.tag_ids."""
    tag = await node_service.create_page("Tag")
    node = await node_service.create_page("Node")

    await node_service.add_tag_link(node.id, tag.id)

    updated = await node_service.get_node(node.id)
    assert updated.tag_ids == [tag.id]


@pytest.mark.asyncio
async def test_add_tag_link_is_idempotent(node_service):
    """add_tag_link does not duplicate tag IDs."""
    tag = await node_service.create_page("Tag")
    node = await node_service.create_page("Node")

    await node_service.add_tag_link(node.id, tag.id)
    await node_service.add_tag_link(node.id, tag.id)

    updated = await node_service.get_node(node.id)
    assert updated.tag_ids == [tag.id]


@pytest.mark.asyncio
async def test_remove_tag_link_updates_tag_ids(node_service):
    """remove_tag_link removes the target from node.tag_ids."""
    tag1 = await node_service.create_page("Tag One")
    tag2 = await node_service.create_page("Tag Two")
    node = await node_service.create_page("Node")

    await node_service.add_tag_link(node.id, tag1.id)
    await node_service.add_tag_link(node.id, tag2.id)
    removed = await node_service.remove_tag_link(node.id, tag1.id)

    assert removed is True
    updated = await node_service.get_node(node.id)
    assert updated.tag_ids == [tag2.id]


@pytest.mark.asyncio
async def test_remove_tag_link_returns_false_when_missing(node_service):
    """remove_tag_link returns False if the tag was not present."""
    tag = await node_service.create_page("Tag")
    node = await node_service.create_page("Node")

    removed = await node_service.remove_tag_link(node.id, tag.id)
    assert removed is False


@pytest.mark.asyncio
async def test_tags_do_not_create_backlinks(node_service):
    """Tag references should not appear as backlinks."""
    tag = await node_service.create_page("Tag")
    node = await node_service.create_page("Node")

    await node_service.add_tag_link(node.id, tag.id)

    backlinks = await node_service.get_backlinks(tag.id)
    assert backlinks == []


@pytest.mark.asyncio
async def test_deleting_tag_target_clears_tag_ids(node_service):
    """When a tag target is deleted, it is removed from all node.tag_ids."""
    tag = await node_service.create_page("Tag")
    node = await node_service.create_page("Node")

    await node_service.add_tag_link(node.id, tag.id)
    await node_service.delete_node(tag.id)

    updated = await node_service.get_node(node.id)
    assert updated.tag_ids == []


@pytest.mark.asyncio
async def test_get_tag_link_targets_batch(node_service):
    """Batch tag lookup returns tag_ids for multiple nodes."""
    tag = await node_service.create_page("Tag")
    node1 = await node_service.create_page("Node One")
    node2 = await node_service.create_page("Node Two")

    await node_service.add_tag_link(node1.id, tag.id)
    await node_service.add_tag_link(node2.id, tag.id)

    result = await node_service.get_tag_link_targets_batch([node1.id, node2.id])
    assert result == {node1.id: [tag.id], node2.id: [tag.id]}


@pytest.mark.asyncio
async def test_update_node_links_does_not_affect_tags(node_service):
    """Re-parsing content links must not clear or alter node.tag_ids."""
    tag = await node_service.create_page("Tag")
    target = await node_service.create_page("Target")
    node = await node_service.create_page("Node")

    await node_service.add_tag_link(node.id, tag.id)
    await node_service.update_node_links(node.id, f"Link to [[{target.id}]]")

    updated = await node_service.get_node(node.id)
    assert updated.tag_ids == [tag.id]
