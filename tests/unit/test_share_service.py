"""Unit tests for ShareService node-level user sharing."""

from __future__ import annotations

from unittest.mock import AsyncMock

import pytest

from app.domain.entities import Node
from app.features.export.service import ExportService
from app.features.shares.service import ShareService
from tests.fakes import FakeEmailSender, FakeNodeRepository, FakeShareRepository, FakeUserRepository


@pytest.fixture
def fake_export_service():
    """Return a no-op AsyncMock stand-in for ExportService."""
    return AsyncMock(spec=ExportService)


@pytest.mark.unit
@pytest.mark.asyncio
async def test_create_node_user_share_for_existing_user(fake_export_service):
    """Sharing with an existing user creates a direct share and sends no email."""
    users = FakeUserRepository()
    owner = users.add_user("owner@example.com", name="Owner")
    target = users.add_user("friend@example.com", name="Friend")
    share_repo = FakeShareRepository(users_by_email={target.email: target})
    node_repo = FakeNodeRepository(nodes={1: Node(id=1, name="Project Plan")})
    email_sender = FakeEmailSender(sent=True)

    service = ShareService(
        share_repo,
        node_repo,
        fake_export_service,
        workspace_id=10,
        user_id=owner.id,
        email_sender=email_sender,
    )
    result = await service.create_node_user_share(1, "friend@example.com", "write")

    assert result["shared_with_email"] == "friend@example.com"
    assert result["permission"] == "write"
    assert result["node_id"] == 1
    assert "share_id" in result
    assert email_sender.calls == []


@pytest.mark.unit
@pytest.mark.asyncio
async def test_create_node_user_share_pending_sends_email_with_node_name(fake_export_service):
    """Sharing with an unknown user sends a pending invite email that includes the node name."""
    users = FakeUserRepository()
    owner = users.add_user("owner@example.com", name="Owner")
    share_repo = FakeShareRepository(users_by_email={})
    node_repo = FakeNodeRepository(nodes={2: Node(id=2, name="Quarterly Goals")})
    email_sender = FakeEmailSender(sent=True)

    service = ShareService(
        share_repo,
        node_repo,
        fake_export_service,
        workspace_id=10,
        user_id=owner.id,
        email_sender=email_sender,
    )
    result = await service.create_node_user_share(2, "stranger@example.com", "read")

    assert result["status"] == "pending"
    assert result["email"] == "stranger@example.com"
    assert result["invite_link"] is not None

    assert len(email_sender.calls) == 1
    call = email_sender.calls[0]
    assert call["recipient"] == "stranger@example.com"
    assert call["inviter_name"] == ""
    assert call["workspace_name"] is None
    assert call["node_name"] == "Quarterly Goals"
    assert call["invite_token"] is not None


@pytest.mark.unit
@pytest.mark.asyncio
async def test_create_node_user_share_pending_without_email_sender(fake_export_service):
    """A pending share returns None invite_link when no email sender is configured."""
    users = FakeUserRepository()
    owner = users.add_user("owner@example.com", name="Owner")
    share_repo = FakeShareRepository(users_by_email={})
    node_repo = FakeNodeRepository(nodes={3: Node(id=3, name="Draft Document")})

    service = ShareService(
        share_repo,
        node_repo,
        fake_export_service,
        workspace_id=10,
        user_id=owner.id,
        email_sender=None,
    )
    result = await service.create_node_user_share(3, "unknown@example.com", "read")

    assert result["status"] == "pending"
    assert result["email"] == "unknown@example.com"
    assert result["invite_link"] is None
