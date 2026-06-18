"""Infrastructure adapter for sending emails via SMTP."""

from __future__ import annotations

from ..config import Settings
from ..domain.ports import EmailSender, InviteEmailResult
from ..utils.email import render_invite_email, send_email


class SmtpEmailSender(EmailSender):
    """Sends invitation emails using configured SMTP settings."""

    def __init__(self, settings: Settings):
        self._settings = settings

    async def send_invite(
        self,
        recipient: str,
        inviter_name: str,
        workspace_name: str | None,
        node_name: str | None,
        invite_token: str,
    ) -> InviteEmailResult:
        """Build the invite URL, render the message, and send it."""
        invite_url = f"{self._settings.public_url}/enroll?token={invite_token}"
        html, plain = render_invite_email(
            inviter_name=inviter_name,
            workspace_name=workspace_name,
            invite_link=invite_url,
            node_name=node_name,
        )
        sent = await send_email(
            recipient, "Invitation to collaborate on Notees", html, plain
        )
        return InviteEmailResult(sent=sent, invite_url=invite_url)
