"""Unit tests for WorkspaceService membership orchestration."""

from __future__ import annotations

import pytest

from app.features.workspaces.service import WorkspaceService
from tests.fakes import FakeEmailSender, FakeUserRepository, FakeWorkspaceRepository


@pytest.fixture
def workspace_repo():
    """Return an empty fake workspace repository."""
    return FakeWorkspaceRepository()


@pytest.fixture
def user_repo():
    """Return an empty fake user repository."""
    return FakeUserRepository()


@pytest.mark.unit
@pytest.mark.asyncio
async def test_invite_existing_user_adds_member_directly(workspace_repo, user_repo):
    """Inviting an existing user creates a workspace_share and sends no email."""
    owner = user_repo.add_user("owner@example.com", name="Owner")
    member = user_repo.add_user("member@example.com", name="Member")
    workspace = workspace_repo.add_workspace("Team", owner.id)
    email_sender = FakeEmailSender(sent=True)

    service = WorkspaceService(workspace_repo, user_repo, email_sender)
    result = await service.invite_member(
        workspace_uuid=str(workspace["uuid"]),
        owner_id=owner.id,
        email="member@example.com",
        role="editor",
        inviter_name="Owner",
    )

    assert result == {"status": "ok", "email": "member@example.com", "role": "editor"}
    assert email_sender.calls == []
    assert await workspace_repo.is_workspace_member(workspace["id"], member.id) is True


@pytest.mark.unit
@pytest.mark.asyncio
async def test_invite_new_user_creates_pending_invite_and_sends_email(workspace_repo, user_repo):
    """Inviting an unknown user creates a pending invite and sends an email."""
    owner = user_repo.add_user("owner@example.com", name="Owner")
    workspace = workspace_repo.add_workspace("Team", owner.id)
    email_sender = FakeEmailSender(sent=True)

    service = WorkspaceService(workspace_repo, user_repo, email_sender)
    result = await service.invite_member(
        workspace_uuid=str(workspace["uuid"]),
        owner_id=owner.id,
        email="new@example.com",
        role="viewer",
        inviter_name="Owner",
    )

    assert result["status"] == "pending"
    assert result["email"] == "new@example.com"
    assert result["role"] == "viewer"
    assert result["invite_link"] is None

    assert len(email_sender.calls) == 1
    call = email_sender.calls[0]
    assert call["recipient"] == "new@example.com"
    assert call["inviter_name"] == "Owner"
    assert call["workspace_name"] == str(workspace["uuid"])
    assert call["node_name"] is None
    assert call["invite_token"] is not None

    pending = await workspace_repo.get_pending_invite(call["invite_token"])
    assert pending is not None
    assert pending["email"] == "new@example.com"
    assert pending["role"] == "viewer"


@pytest.mark.unit
@pytest.mark.asyncio
async def test_invite_new_user_returns_link_when_email_not_sent(workspace_repo, user_repo):
    """If no email sender is configured, the pending response has invite_link=None."""
    owner = user_repo.add_user("owner@example.com", name="Owner")
    workspace = workspace_repo.add_workspace("Team", owner.id)

    service = WorkspaceService(workspace_repo, user_repo, email_sender=None)
    result = await service.invite_member(
        workspace_uuid=str(workspace["uuid"]),
        owner_id=owner.id,
        email="new@example.com",
        role="commenter",
        inviter_name="Owner",
    )

    assert result == {
        "status": "pending",
        "email": "new@example.com",
        "role": "commenter",
        "invite_link": None,
    }


@pytest.mark.unit
@pytest.mark.asyncio
async def test_invite_self_is_rejected(workspace_repo, user_repo):
    """A workspace owner cannot invite themselves."""
    owner = user_repo.add_user("owner@example.com", name="Owner")
    workspace = workspace_repo.add_workspace("Team", owner.id)
    email_sender = FakeEmailSender(sent=True)

    service = WorkspaceService(workspace_repo, user_repo, email_sender)
    with pytest.raises(ValueError, match="Cannot invite yourself"):
        await service.invite_member(
            workspace_uuid=str(workspace["uuid"]),
            owner_id=owner.id,
            email="owner@example.com",
            role="editor",
            inviter_name="Owner",
        )


@pytest.mark.unit
@pytest.mark.asyncio
async def test_invite_by_non_owner_is_rejected(workspace_repo, user_repo):
    """Only the workspace owner may invite members."""
    owner = user_repo.add_user("owner@example.com", name="Owner")
    other = user_repo.add_user("other@example.com", name="Other")
    workspace = workspace_repo.add_workspace("Team", owner.id)
    email_sender = FakeEmailSender(sent=True)

    service = WorkspaceService(workspace_repo, user_repo, email_sender)
    with pytest.raises(PermissionError, match="Only workspace owners can invite members"):
        await service.invite_member(
            workspace_uuid=str(workspace["uuid"]),
            owner_id=other.id,
            email="new@example.com",
            role="viewer",
            inviter_name="Other",
        )
