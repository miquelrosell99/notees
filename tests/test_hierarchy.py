"""Tests for node hierarchy operations: moves, depth limits, circular refs, merges."""
import pytest

from app.domain.entities import NodeCreateData


@pytest.mark.asyncio
async def test_circular_reference_prevention(node_service, test_workspace_id):
    """Test that circular references are prevented in move_node."""
    node_a = await node_service.create_page("Node A")
    node_b = await node_service.create_block("Node B", parent_id=node_a.id, sequence=0)
    node_c = await node_service.create_block("Node C", parent_id=node_b.id, sequence=0)

    with pytest.raises(ValueError, match="circular reference"):
        await node_service.move_node(node_a.id, node_c.id, 0)

    with pytest.raises(ValueError, match="circular reference"):
        await node_service.move_node(node_a.id, node_b.id, 0)

    with pytest.raises(ValueError, match="own parent"):
        await node_service.move_node(node_a.id, node_a.id, 0)

    node_d = await node_service.create_page("Node D")
    result = await node_service.move_node(node_b.id, node_d.id, 0)
    assert result is not None
    assert result.parent_id == node_d.id


@pytest.mark.integration
@pytest.mark.asyncio
async def test_move_node_exceeds_max_depth(authenticated_client, node_service):
    """Test that moving a node to exceed MAX_HIERARCHY_DEPTH fails."""
    from app.features.nodes.node_service import MAX_HIERARCHY_DEPTH

    parent_id = None
    nodes = []

    for i in range(MAX_HIERARCHY_DEPTH - 10):
        data = NodeCreateData(name=f"Node {i}", parent_id=parent_id)
        node = await node_service.create_node(data)
        nodes.append(node)
        parent_id = node.id

    subtree_root_data = NodeCreateData(name="Subtree Root")
    subtree_root = await node_service.create_node(subtree_root_data)

    subtree_parent_id = subtree_root.id
    for i in range(15):
        data = NodeCreateData(name=f"Subtree {i}", parent_id=subtree_parent_id)
        node = await node_service.create_node(data)
        subtree_parent_id = node.id

    with pytest.raises(ValueError) as exc_info:
        await node_service.move_node(subtree_root.id, parent_id, 0)

    assert "maximum hierarchy depth" in str(exc_info.value).lower()


@pytest.mark.integration
@pytest.mark.asyncio
async def test_move_node_within_depth_limit_succeeds(authenticated_client, node_service):
    """Test that moves within the depth limit succeed."""
    parent_data = NodeCreateData(name="Parent")
    parent = await node_service.create_node(parent_data)

    child_data = NodeCreateData(name="Child", parent_id=parent.id)
    child = await node_service.create_node(child_data)

    new_parent_data = NodeCreateData(name="New Parent")
    new_parent = await node_service.create_node(new_parent_data)

    moved_node = await node_service.move_node(child.id, new_parent.id, 0)
    assert moved_node is not None
    assert moved_node.parent_id == new_parent.id


@pytest.mark.asyncio
async def test_merge_pages(node_service):
    """Test merging a source page into a target page."""
    source = await node_service.create_page("Source Page")
    child1 = await node_service.create_block("Child 1", parent_id=source.id, sequence=0)
    child2 = await node_service.create_block("Child 2", parent_id=source.id, sequence=1)
    grandchild = await node_service.create_block("Grandchild", parent_id=child1.id, sequence=0)

    target = await node_service.create_page("Target Page")

    result = await node_service.merge_pages(source.id, target.id)
    assert result["children_moved"] == 2
    assert result["target_id"] == target.id

    assert await node_service.get_node(source.id) is None

    target_children = await node_service.get_node_children(target.id)
    target_child_ids = {c.id for c in target_children}
    assert child1.id in target_child_ids
    assert child2.id in target_child_ids

    child1_children = await node_service.get_node_children(child1.id)
    assert len(child1_children) == 1
    assert child1_children[0].id == grandchild.id


@pytest.mark.integration
@pytest.mark.asyncio
async def test_move_node_endpoint_maps_position_to_fractional_sequence(
    authenticated_client, node_service
):
    """The /move endpoint should interpret position as a sibling index, not a raw sequence."""
    page = await node_service.create_page("Move Pos Page")
    child_a = await node_service.create_block("A", parent_id=page.id, sequence=0)
    _child_b = await node_service.create_block("B", parent_id=page.id, sequence=1024)

    response = await authenticated_client.put(
        f"/api/nodes/{child_a.uuid}/move",
        json={"parent_uuid": str(page.uuid), "position": 1},
    )
    assert response.status_code == 200

    moved = await node_service.get_node(child_a.id)
    assert moved is not None
    assert 0 < moved.sequence < 1024
