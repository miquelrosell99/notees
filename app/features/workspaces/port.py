"""Repository interfaces (ports) for the workspaces feature."""

from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Any


class WorkspaceRepository(ABC):
    """Repository interface for workspace lifecycle, membership, and invite operations."""

    @abstractmethod
    async def list_workspaces(self, user_id: int) -> list[Any]:
        """List all workspaces accessible to a user (owned + shared).

        Returns raw rows with workspace info plus share permission columns.
        """
        pass

    @abstractmethod
    async def get_by_name_and_owner(self, name: str, owner_id: int) -> Any | None:
        """Get an active workspace by name and owner."""
        pass

    @abstractmethod
    async def create(self, name: str, owner_id: int) -> Any:
        """Create a new workspace and return the inserted row."""
        pass

    @abstractmethod
    async def get_by_uuid_for_user(self, workspace_uuid: str, user_id: int) -> Any | None:
        """Get a workspace by UUID if the user has access."""
        pass

    @abstractmethod
    async def rename(self, workspace_id: int, new_name: str, owner_id: int) -> Any | None:
        """Rename a workspace (owner only) and return the updated row."""
        pass

    @abstractmethod
    async def get_id_by_uuid_and_owner(self, workspace_uuid: str, owner_id: int) -> int | None:
        """Get a workspace ID by UUID, verifying the user is the owner."""
        pass

    @abstractmethod
    async def delete_cascade(self, workspace_id: int) -> bool:
        """Hard-delete a workspace and all its data.

        Disables triggers for bulk deletion, removes node/activity/link/property
        rows, deletes the workspace row, and returns True if a row was deleted.
        """
        pass

    @abstractmethod
    async def resolve_workspace_for_export(
        self, user_id: int, workspace_uuid: str | None = None
    ) -> int:
        """Resolve a workspace ID for export operations."""
        pass

    @abstractmethod
    async def seed_workspace(self, workspace_id: int, user_id: int) -> None:
        """Seed a new workspace with system classes, properties, and pages."""
        pass

    @abstractmethod
    async def ensure_user_page(self, workspace_id: int, user_id: int) -> int | None:
        """Create a system user page node if the user doesn't have one yet."""
        pass

    @abstractmethod
    async def get_workspace_uuid_by_name_for_user(self, name: str, user_id: int) -> str | None:
        """Resolve a workspace UUID from its name for a user (owner or shared)."""
        pass

    @abstractmethod
    async def get_workspace_id_owner(self, workspace_uuid: str) -> tuple[int, int] | None:
        """Return (workspace_id, owner_id) for an active workspace, or None."""
        pass

    @abstractmethod
    async def is_workspace_member(self, workspace_id: int, user_id: int) -> bool:
        """Return True if the user has an active workspace_share record."""
        pass

    @abstractmethod
    async def invite_existing_member(
        self, workspace_id: int, target_id: int, role: str, owner_id: int
    ) -> None:
        """Upsert a workspace_share record for an existing user."""
        pass

    @abstractmethod
    async def create_pending_invite(
        self, workspace_id: int, email: str, role: str, invited_by: int
    ) -> str:
        """Create or refresh a pending_invite record and return its UUID."""
        pass

    @abstractmethod
    async def list_members(
        self, workspace_id: int, page: int, page_size: int
    ) -> dict[str, Any]:
        """Return owner, shared members, and pending invites for a workspace."""
        pass

    @abstractmethod
    async def update_member_role(
        self, workspace_id: int, member_user_id: int, role: str, owner_id: int
    ) -> bool:
        """Update an active member's role. Returns True if a row was updated."""
        pass

    @abstractmethod
    async def remove_member(self, workspace_id: int, member_user_id: int) -> None:
        """Soft-remove a member by marking their workspace_share record inactive."""
        pass

    @abstractmethod
    async def remove_pending_invite(self, workspace_id: int, email: str) -> None:
        """Cancel a pending invite by email for a workspace-wide invite."""
        pass

class WorkspaceIORepository(ABC):
    """Repository interface for workspace import/export and restore operations."""

    @abstractmethod
    async def export_workspace_full(self, workspace_id: int) -> dict:
        """Create a comprehensive dump of all workspace data."""
        pass

    @abstractmethod
    async def create_workspace_for_import(self, name: str, owner_id: int) -> dict:
        """Insert a workspace for import and return row dict with id/uuid/name/create_date."""
        pass

    @abstractmethod
    async def get_workspace_by_name_for_user(self, name: str, user_id: int) -> dict | None:
        """Get workspace row with id/uuid/name by name for a user."""
        pass

    @abstractmethod
    async def get_workspace_by_uuid_for_user(self, uuid: str, user_id: int) -> dict | None:
        """Get workspace row with id/uuid/name by uuid for a user."""
        pass

    @abstractmethod
    async def import_dump(
        self, workspace_id: int, user_id: int, dump_data: dict, remap_uuids: bool
    ) -> tuple[dict, dict[str, str]]:
        """Run the entire multi-phase import inside a single DB transaction.

        Returns (stats, uuid_map).
        """
        pass

    @abstractmethod
    async def delete_all_workspace_data(self, workspace_id: int) -> None:
        """Delete node_view, node_link, setting_workspace, node, property rows."""
        pass

    @abstractmethod
    async def restore_workspace(self, workspace_id: int, user_id: int, dump_data: dict) -> dict:
        """Delete all data then import with remap_uuids=False."""
        pass

    @abstractmethod
    async def list_page_uuids(self, workspace_id: int) -> list[dict]:
        """List active page UUIDs and names."""
        pass

    @abstractmethod
    async def list_asset_uuids(self, workspace_id: int) -> list[dict]:
        """List active asset UUIDs and names."""
        pass
