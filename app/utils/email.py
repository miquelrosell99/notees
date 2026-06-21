"""Email utilities for Notees.

Uses smtplib via asyncio.to_thread so the event loop is never blocked.
If SMTP is not configured, emails are logged instead of sent.
"""

from __future__ import annotations

import asyncio
import smtplib
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText

from ..config import settings
from ..logging_config import get_logger

logger = get_logger(__name__)


async def send_email(
    to: str,
    subject: str,
    body_html: str | None = None,
    body_text: str | None = None,
) -> bool:
    """Send an email asynchronously.

    Returns True if the email was handed off to the MTA, False if SMTP is
    not configured (in which case only metadata is logged).
    """
    if not settings.smtp_host:
        body = body_text or body_html or ""
        logger.info(
            "Would send email (SMTP not configured): recipient count=1, "
            "body length=%s, subject length=%s",
            len(body),
            len(subject),
        )
        return False

    def _send() -> bool:
        msg = MIMEMultipart("alternative")
        msg["Subject"] = subject
        msg["From"] = settings.smtp_from or settings.smtp_user or "notees@localhost"
        msg["To"] = to

        if body_text:
            msg.attach(MIMEText(body_text, "plain"))
        if body_html:
            msg.attach(MIMEText(body_html, "html"))

        try:
            if settings.smtp_tls:
                server = smtplib.SMTP(settings.smtp_host, settings.smtp_port)
                server.starttls()
            else:
                server = smtplib.SMTP(settings.smtp_host, settings.smtp_port)

            if settings.smtp_user and settings.smtp_password:
                server.login(settings.smtp_user, settings.smtp_password)

            server.sendmail(msg["From"], [to], msg.as_string())
            server.quit()
            return True
        except Exception as exc:
            logger.warning("Email send failed: %s", exc)
            return False

    return await asyncio.to_thread(_send)


def render_invite_email(
    inviter_name: str,
    workspace_name: str | None,
    invite_link: str,
    node_name: str | None = None,
) -> tuple[str, str]:
    """Render invitation email templates.

    Returns (html, plain_text).
    """
    target = f'"{node_name}"' if node_name else f'workspace "{workspace_name or "Notees"}"'

    plain = (
        f"Hi,\n\n"
        f"{inviter_name} has invited you to collaborate on {target} in Notees.\n\n"
        f"Click the link below to accept the invitation and create your account:\n\n"
        f"{invite_link}\n\n"
        f"This link will expire in 7 days.\n\n"
        f"— Notees"
    )

    html = f"""<!DOCTYPE html>
<html>
<body style="font-family: sans-serif; line-height: 1.5; color: #111111;">
  <p>Hi,</p>
  <p><strong>{inviter_name}</strong> has invited you to collaborate on {target} in <strong>Notees</strong>.</p>
  <p style="margin: 24px 0;">
    <a href="{invite_link}" style="background:#5B7D5B;color:#FFFFFF;padding:10px 20px;text-decoration:none;border-radius:6px;display:inline-block;">
      Accept Invitation
    </a>
  </p>
  <p>Or copy this link into your browser:<br/>
     <code style="background:#f5f3ef;padding:4px 8px;border-radius:4px;color:#111111;">{invite_link}</code>
  </p>
  <p style="font-size: 0.875rem; color: #5c5c5c;">This link will expire in 7 days.</p>
  <p>— Notees</p>
</body>
</html>"""

    return html, plain
