"""Public share entity for tokenized anonymous node access."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime

from ...utils import utc_now_iso


@dataclass
class PublicShare:
    """Domain entity representing a public share link for a node."""

    id: int | None = None
    uuid: str = ""
    node_id: int = 0
    workspace_id: int = 0
    created_by: int = 0
    created_at: str = field(default_factory=utc_now_iso)
    expiry_date: str | None = None
    active: bool = True

    def is_expired(self) -> bool:
        """Check if the share has expired."""
        if self.expiry_date is None:
            return False
        try:
            expiry = datetime.fromisoformat(self.expiry_date.replace("Z", "+00:00"))
            return expiry < datetime.now(tz=expiry.tzinfo)
        except (ValueError, TypeError):
            return False

    def is_valid(self) -> bool:
        """Check if the share is active and not expired."""
        return self.active and not self.is_expired()
