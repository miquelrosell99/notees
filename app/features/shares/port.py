"""Repository interface (port) for share operations."""

from __future__ import annotations

from abc import ABC, abstractmethod
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from app.domain.entities import Node
    from app.domain.entities.share import PublicShare


class ShareRepository(ABC):
    """Repository interface for public share link operations."""

    @abstractmethod
    async def create_share(
        self,
        node_id: int,
        workspace_id: int,
        created_by: int,
        expiry_date: str | None = None,
    ) -> PublicShare:
        """Create a new public share for a node."""
        pass

    @abstractmethod
    async def get_share_by_uuid(self, share_uuid: str) -> PublicShare | None:
        """Get a share by its UUID token."""
        pass

    @abstractmethod
    async def list_shares_for_node(self, node_id: int) -> list[PublicShare]:
        """List all active shares for a node."""
        pass

    @abstractmethod
    async def list_shares_for_workspace(self, workspace_id: int) -> list[PublicShare]:
        """List all active shares in a workspace."""
        pass

    @abstractmethod
    async def delete_share(self, share_uuid: str) -> bool:
        """Revoke (soft-delete) a share by its UUID."""
        pass

    @abstractmethod
    async def get_shared_node(self, share_uuid: str) -> Node | None:
        """Get the node associated with a valid share."""
        pass

    @abstractmethod
    async def set_share_password(self, share_id: int, password_hash: str) -> None:
        """Set a password hash on a public share."""
        pass

    @abstractmethod
    async def list_share_inbox(
        self, user_id: int, page: int, page_size: int
    ) -> tuple[int, list[Any]]:
        """Get paginated node shares for a user."""
        pass

    @abstractmethod
    async def create_node_user_share(
        self,
        node_id: int,
        workspace_id: int,
        user_id: int,
        target_email: str,
        permission: str,
    ) -> dict[str, Any] | None:
        """Create or update a node-level user share. May create a pending invite.

        Returns a dict describing the result. For direct shares it includes the
        inserted share row; for invites it returns {"status": "pending", ...}.
        """
        pass

    @abstractmethod
    async def list_node_user_shares(
        self, node_id: int, workspace_id: int, user_id: int
    ) -> tuple[bool, list[Any]]:
        """List user shares for a node.

        Returns (is_owner, rows).
        """
        pass

    @abstractmethod
    async def revoke_user_share(
        self, share_id: int, workspace_id: int, user_id: int
    ) -> dict[str, Any] | None:
        """Revoke a node user share and clear is_shared if no shares remain.

        Returns {"node_id": node_id} on success, or None if not found/forbidden.
        """
        pass
