"""Domain ports (abstract interfaces) for infrastructure adapters."""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass
from pathlib import Path
from typing import Any


@dataclass(frozen=True)
class PushNotification:
    """A push notification payload to be delivered to one or more devices."""

    title: str
    body: str
    data: dict[str, Any] | None = None


@dataclass(frozen=True)
class PushSendResult:
    """Result of a push notification send attempt."""

    success: bool
    message: str | None = None


@dataclass(frozen=True)
class InviteEmailResult:
    """Result of sending an invitation email."""

    sent: bool
    invite_url: str


class EmailSender(ABC):
    """Port for sending invitation emails."""

    @abstractmethod
    async def send_invite(
        self,
        recipient: str,
        inviter_name: str,
        workspace_name: str | None,
        node_name: str | None,
        invite_token: str,
    ) -> InviteEmailResult:
        """Send an invitation email and return the result."""
        ...


class NodeExportRenderer(ABC):
    """Port for node export rendering, file paths, and YAML frontmatter."""

    @abstractmethod
    async def render_html(
        self,
        nodes: list[Any],
        resolver: Any,
        layout: str,
        formatting: bool,
        style: str | None,
        properties_data: dict[str, list] | None,
        density: str,
        numbering: str,
        measure: str,
        doctype: str,
        section_break: bool,
        strip_link_syntax: bool,
        code_class_id: str | None,
        quote_class_id: str | None,
        callout_class_map: dict[str, str] | None,
        theme_mode: str,
        cover_page: bool,
        page_size: str,
        cover_metadata: dict[str, Any] | None,
    ) -> str:
        """Render nodes to a complete HTML document string."""
        ...

    @abstractmethod
    async def render_pdf(self, html_content: str, page_size: str) -> bytes:
        """Render an HTML string to a PDF document."""
        ...

    @abstractmethod
    def build_yaml_frontmatter(self, metadata: dict[str, Any]) -> str:
        """Build a YAML frontmatter block from metadata."""
        ...

    @abstractmethod
    def static_share_path(self, share_uuid: str) -> Path:
        """Return the filesystem path for a static share HTML file."""
        ...

    @abstractmethod
    def delete_share_html(self, share_uuid: str) -> None:
        """Delete the static HTML file for a share, if it exists."""
        ...


class PushNotificationSender(ABC):
    """Port for sending push notifications to mobile/desktop devices."""

    @abstractmethod
    async def send_to_tokens(
        self,
        tokens: list[str],
        notification: PushNotification,
    ) -> PushSendResult:
        """Send a notification to the given device tokens."""
        ...

    @abstractmethod
    def is_configured(self) -> bool:
        """Return True if the adapter is configured and able to send pushes."""
        ...
