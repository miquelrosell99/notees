"""Tests for input validation on node create and update operations."""
import pytest

from app.domain.entities import NodeCreateData, NodeUpdateData
from app.domain.validation import ValidationError


class TestInputValidation:
    """Test input validation for node create/update operations."""

    @pytest.mark.asyncio
    async def test_create_node_with_oversized_name(self, authenticated_client, node_service):
        """Test that creating a node with name > 50KB fails."""
        huge_name = "x" * (50 * 1024 + 1)
        data = NodeCreateData(name=huge_name)

        with pytest.raises(ValidationError) as exc_info:
            await node_service.create_node(data)

        assert "name is too long" in str(exc_info.value).lower()

    @pytest.mark.asyncio
    async def test_create_node_with_invalid_icon(self, authenticated_client, node_service):
        """Test that creating a node with icon > 100 chars fails."""
        long_icon = "x" * 101
        data = NodeCreateData(name="Test Node", icon=long_icon)

        with pytest.raises(ValidationError) as exc_info:
            await node_service.create_node(data)

        assert "exceeds maximum length" in str(exc_info.value).lower()

    @pytest.mark.asyncio
    async def test_create_node_with_control_characters(self, authenticated_client, node_service):
        """Test that control characters in name are rejected."""
        name_with_control = "Test\x00Node\x01"
        data = NodeCreateData(name=name_with_control)

        with pytest.raises(ValidationError) as exc_info:
            await node_service.create_node(data)

        assert "control character" in str(exc_info.value).lower()

    @pytest.mark.asyncio
    async def test_create_node_with_invalid_color(self, authenticated_client, node_service):
        """Test that invalid color formats are rejected."""
        data = NodeCreateData(name="Test Node", color="not-a-color")

        with pytest.raises(ValidationError) as exc_info:
            await node_service.create_node(data)

        assert "color" in str(exc_info.value).lower()

    @pytest.mark.asyncio
    async def test_update_node_validation(self, authenticated_client, node_service):
        """Test that update validation works the same as create validation."""
        data = NodeCreateData(name="Test Node")
        node = await node_service.create_node(data)

        huge_name = "x" * (50 * 1024 + 1)
        update_data = NodeUpdateData(name=huge_name)

        with pytest.raises(ValidationError):
            await node_service.update_node(node.id, update_data)
