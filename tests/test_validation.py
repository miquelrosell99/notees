"""Tests for input validation on node create/update and invite acceptance."""

import pytest
from pydantic import ValidationError as PydanticValidationError

from app.domain.validation import ValidationError, validate_node_create, validate_node_update
from app.models import InviteAcceptRequest


@pytest.mark.unit
class TestInputValidation:
    """Test input validation for node create/update operations."""

    def test_create_node_with_oversized_name(self):
        """Creating a node with name > 50KB fails."""
        huge_name = "x" * (50 * 1024 + 1)

        with pytest.raises(ValidationError) as exc_info:
            validate_node_create(name=huge_name)

        assert "name is too long" in str(exc_info.value).lower()

    def test_create_node_with_invalid_icon(self):
        """Creating a node with icon > 100 chars fails."""
        long_icon = "x" * 101

        with pytest.raises(ValidationError) as exc_info:
            validate_node_create(name="Test Node", icon=long_icon)

        assert "exceeds maximum length" in str(exc_info.value).lower()

    def test_create_node_with_control_characters(self):
        """Control characters in name are rejected."""
        name_with_control = "Test\x00Node\x01"

        with pytest.raises(ValidationError) as exc_info:
            validate_node_create(name=name_with_control)

        assert "control character" in str(exc_info.value).lower()

    def test_create_node_with_invalid_color(self):
        """Invalid color formats are rejected."""
        with pytest.raises(ValidationError) as exc_info:
            validate_node_create(name="Test Node", color="not-a-color")

        assert "color" in str(exc_info.value).lower()

    def test_update_node_validation(self):
        """Update validation works the same as create validation."""
        huge_name = "x" * (50 * 1024 + 1)

        with pytest.raises(ValidationError):
            validate_node_update(name=huge_name)


class TestInviteAcceptPasswordValidation:
    """Test password complexity validation on invite acceptance."""

    def test_invite_accept_allows_none_password(self):
        """Existing users accepting an invite do not supply a password."""
        request = InviteAcceptRequest(token="abc", password=None, name="Test")
        assert request.password is None

    def test_invite_accept_rejects_weak_password(self):
        """New accounts must provide a password meeting complexity rules."""
        with pytest.raises(PydanticValidationError) as exc_info:
            InviteAcceptRequest(token="abc", password="weak", name="Test")

        assert "at least 8 characters" in str(exc_info.value)

    def test_invite_accept_rejects_password_without_uppercase(self):
        """Passwords must contain an uppercase letter."""
        with pytest.raises(PydanticValidationError) as exc_info:
            InviteAcceptRequest(token="abc", password="lowercase1!", name="Test")

        assert "uppercase" in str(exc_info.value).lower()

    def test_invite_accept_accepts_strong_password(self):
        """A valid complex password is accepted."""
        request = InviteAcceptRequest(token="abc", password="Strong1!Pass", name="Test")
        assert request.password == "Strong1!Pass"
