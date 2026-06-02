"""Tests for optimistic locking and version-based conflict detection."""
import pytest

from app.domain.entities import NodeCreateData, NodeUpdateData
from app.domain.errors import OptimisticLockError


class TestOptimisticLocking:
    """Test optimistic locking for concurrent edit detection."""

    @pytest.mark.skip(reason="Optimistic locking via expected_version is not yet implemented in NodeService.update_node()")
    @pytest.mark.asyncio
    async def test_concurrent_update_conflict(self, authenticated_client, node_service, node_repository):
        """Test that concurrent updates are detected via version field."""
        data = NodeCreateData(name="Original Name")
        node = await node_service.create_node(data)
        original_version = node.version

        update1 = NodeUpdateData(name="Updated by User 1")
        updated1 = await node_service.update_node(
            node.id,
            update1,
        )
        assert updated1 is not None
        assert updated1.version == original_version + 1

        update2 = NodeUpdateData(name="Updated by User 2")
        with pytest.raises(OptimisticLockError) as exc_info:
            await node_service.update_node(
                node.id,
                update2,
            )

        assert "version" in str(exc_info.value).lower()
        assert str(node.id) in str(exc_info.value) or "conflict" in str(exc_info.value).lower()

    @pytest.mark.asyncio
    async def test_update_without_version_check_succeeds(self, node_service):
        """Test that updates without expected_version always succeed."""
        node = await node_service.create_page("Original Name")

        update1 = NodeUpdateData(name="First Update")
        updated1 = await node_service.update_node(node.id, update1)
        assert updated1 is not None

        update2 = NodeUpdateData(name="Second Update")
        updated2 = await node_service.update_node(node.id, update2)
        assert updated2 is not None

    @pytest.mark.asyncio
    async def test_version_increments_on_update(self, node_service):
        """Test that version field increments with each update."""
        node = await node_service.create_page("Test Node")
        initial_version = node.version

        prev_version = initial_version
        for i in range(3):
            update = NodeUpdateData(name=f"Update {i}")
            node = await node_service.update_node(node.id, update)
            assert node.version > prev_version
            prev_version = node.version

    @pytest.mark.asyncio
    async def test_undo_redo_metadata(self, node_service):
        """Test that history metadata (version) is preserved for undo/redo operations."""
        node = await node_service.create_page("Original")

        updated = await node_service.update_node(
            node.id,
            NodeUpdateData(name="Updated")
        )

        assert updated.version > node.version
        assert updated.write_date > node.create_date
