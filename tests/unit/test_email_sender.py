"""Unit tests for the SMTP email-sender adapter."""

from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest

from app.config import Settings
from app.infrastructure.email import SmtpEmailSender


@pytest.mark.unit
@pytest.mark.asyncio
async def test_smtp_email_sender_builds_invite_url_and_sends():
    """When send_email succeeds, the result reports sent=True and the invite URL."""
    settings = Settings(public_url="https://notees.example.com", secret_key="x" * 32)
    sender = SmtpEmailSender(settings)

    with (
        patch("app.infrastructure.email.send_email", new_callable=AsyncMock) as mock_send,
        patch("app.infrastructure.email.render_invite_email") as mock_render,
    ):
        mock_send.return_value = True
        mock_render.return_value = ("<html>invite</html>", "plain invite")

        result = await sender.send_invite(
            recipient="new@example.com",
            inviter_name="Alice",
            workspace_name="Team Workspace",
            node_name=None,
            invite_token="abc-123",
        )

        assert result.sent is True
        assert result.invite_url == "https://notees.example.com/enroll?token=abc-123"
        mock_send.assert_awaited_once_with(
            "new@example.com",
            "Invitation to collaborate on Notees",
            "<html>invite</html>",
            "plain invite",
        )


@pytest.mark.unit
@pytest.mark.asyncio
async def test_smtp_email_sender_returns_false_when_send_email_fails():
    """When send_email returns False, the result reports sent=False but still returns the URL."""
    settings = Settings(public_url="http://localhost:8000", secret_key="x" * 32)
    sender = SmtpEmailSender(settings)

    with (
        patch("app.infrastructure.email.send_email", new_callable=AsyncMock) as mock_send,
        patch("app.infrastructure.email.render_invite_email") as mock_render,
    ):
        mock_send.return_value = False
        mock_render.return_value = ("<html>invite</html>", "plain invite")

        result = await sender.send_invite(
            recipient="new@example.com",
            inviter_name="Alice",
            workspace_name="Team Workspace",
            node_name=None,
            invite_token="def-456",
        )

        assert result.sent is False
        assert result.invite_url == "http://localhost:8000/enroll?token=def-456"


@pytest.mark.unit
@pytest.mark.asyncio
async def test_smtp_email_sender_renders_with_workspace_name():
    """render_invite_email receives the workspace name when no node name is supplied."""
    settings = Settings(public_url="https://notees.example.com", secret_key="x" * 32)
    sender = SmtpEmailSender(settings)

    with (
        patch("app.infrastructure.email.send_email", new_callable=AsyncMock) as mock_send,
        patch("app.infrastructure.email.render_invite_email") as mock_render,
    ):
        mock_send.return_value = True
        mock_render.return_value = ("<html>invite</html>", "plain invite")

        await sender.send_invite(
            recipient="new@example.com",
            inviter_name="Alice",
            workspace_name="Team Workspace",
            node_name=None,
            invite_token="abc-123",
        )

        mock_render.assert_called_once_with(
            inviter_name="Alice",
            workspace_name="Team Workspace",
            invite_link="https://notees.example.com/enroll?token=abc-123",
            node_name=None,
        )


@pytest.mark.unit
@pytest.mark.asyncio
async def test_smtp_email_sender_renders_with_node_name():
    """render_invite_email receives the node name when sharing a single node."""
    settings = Settings(public_url="https://notees.example.com", secret_key="x" * 32)
    sender = SmtpEmailSender(settings)

    with (
        patch("app.infrastructure.email.send_email", new_callable=AsyncMock) as mock_send,
        patch("app.infrastructure.email.render_invite_email") as mock_render,
    ):
        mock_send.return_value = True
        mock_render.return_value = ("<html>invite</html>", "plain invite")

        await sender.send_invite(
            recipient="new@example.com",
            inviter_name="Bob",
            workspace_name=None,
            node_name="Project Plan",
            invite_token="node-token",
        )

        mock_render.assert_called_once_with(
            inviter_name="Bob",
            workspace_name=None,
            invite_link="https://notees.example.com/enroll?token=node-token",
            node_name="Project Plan",
        )
