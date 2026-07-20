"""Shared repository interfaces (ports) used by multiple features.

Feature-specific repository interfaces live in their owning feature's
``port.py`` module and should be imported from there.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from datetime import datetime
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from ..permissions import Permissions


class QueryRepository(ABC):
    """Repository interface for executing QueryAST-based queries."""

    @abstractmethod
    async def execute_query(
        self,
        query: Any,
        runtime_params: dict[str, Any] | None = None,
        limit: int | None = None,
        offset: int | None = None,
        order_by: str | None = None,
        enrich: dict[str, bool] | None = None,
    ) -> dict[str, Any]:
        """Execute a query and return results with optional pagination metadata."""
        pass

    @abstractmethod
    async def count_query_results(
        self,
        query: Any,
        runtime_params: dict[str, Any] | None = None,
    ) -> int:
        """Count results for a query without fetching all data."""
        pass


class PermissionRepository(ABC):
    """Repository interface for permission-related database queries."""

    @abstractmethod
    async def get_workspace_owner(self, workspace_id: int) -> int | None:
        """Return the create_uid of the active workspace, or None if not found."""
        pass

    @abstractmethod
    async def get_workspace_share(self, workspace_id: int, user_id: int) -> Permissions | None:
        """Return workspace-level share permissions for a user, or None."""
        pass

    @abstractmethod
    async def get_node_info(self, node_uuid: str, active_only: bool) -> dict[str, Any] | None:
        """Return node workspace_id, create_uid, is_private (and is_shared) row."""
        pass

    @abstractmethod
    async def get_node_share(self, node_uuid: str, user_id: int) -> Permissions | None:
        """Return explicit node_share permissions for a user, or None."""
        pass

    @abstractmethod
    async def get_ancestor_node_share(self, node_uuid: str, user_id: int) -> Permissions | None:
        """Return inherited share permissions from the closest ancestor page."""
        pass

    @abstractmethod
    async def get_accessible_workspace_ids(self, user_id: int) -> list[int]:
        """Return all workspace IDs the user can read (owned + shared)."""
        pass


class SettingsRepository(ABC):
    """Repository interface for user and workspace settings."""

    @abstractmethod
    async def get_user_settings(self, user_id: int) -> dict:
        """Return all settings for a user as a key→value dict."""
        pass

    @abstractmethod
    async def get_user_setting(self, user_id: int, key: str) -> Any | None:
        """Return a single user setting value, or None if not set."""
        pass

    @abstractmethod
    async def set_user_setting(self, user_id: int, key: str, value: Any, now: Any) -> None:
        """Upsert a single user setting (value is a native JSON-serializable value)."""
        pass

    @abstractmethod
    async def get_user_favorites(self, user_id: int) -> list[int]:
        """Return the user's favorite node IDs as a list of ints."""
        pass

    @abstractmethod
    async def set_user_favorites(self, user_id: int, favorites: list[int], now: Any | None = None) -> None:
        """Persist the user's favorite node IDs."""
        pass

    @abstractmethod
    async def get_workspace_id_by_uuid(self, uuid: str) -> int | None:
        """Resolve a workspace UUID to its integer primary key."""
        pass

    @abstractmethod
    async def get_workspace_settings(self, workspace_id: int) -> dict:
        """Return all settings for a workspace as a key→value dict."""
        pass

    @abstractmethod
    async def set_workspace_setting(self, workspace_id: int, key: str, value: Any, now: Any, user_id: int) -> None:
        """Upsert a single workspace setting (value is a native JSON-serializable value)."""
        pass

    @abstractmethod
    async def remove_node_from_favorites(self, node_id: int) -> None:
        """Remove a node ID from all users' favorites lists."""
        pass


class SystemSettingsRepository(ABC):
    """Repository interface for global system settings (setting_system table)."""

    @abstractmethod
    async def get(self, key: str, default: Any = None) -> Any:
        """Return the JSONB value for a system setting, or the default."""
        pass

    @abstractmethod
    async def set(self, key: str, value: Any) -> None:
        """Upsert a system setting value."""
        pass

    @abstractmethod
    async def get_all(self) -> dict[str, Any]:
        """Return all system settings as a key→value dict."""
        pass


class CleanupRepository(ABC):
    """Repository interface for cleanup/retention policies."""

    @abstractmethod
    async def list_active_workspaces(self) -> list[dict[str, Any]]:
        """Return id/uuid rows for all active workspaces."""
        pass

    @abstractmethod
    async def user_exists(self, user_id: str) -> bool:
        """Return True if a user exists by id or uuid text."""
        pass

    @abstractmethod
    async def get_workspace_setting(self, workspace_id: int, key: str, default: Any) -> Any:
        """Return a workspace setting value, or the default."""
        pass

    @abstractmethod
    async def hard_delete_trashed_nodes_batch(
        self, workspace_id: int, cutoff: datetime, batch_size: int
    ) -> list[dict[str, Any]]:
        """Return and permanently delete a batch of trashed nodes older than cutoff."""
        pass

    @abstractmethod
    async def delete_activity_logs_older_than(self, workspace_id: int, cutoff: datetime) -> int:
        """Delete old activity logs and return the number of rows removed."""
        pass

    @abstractmethod
    async def delete_task_completions_older_than(self, workspace_id: int, cutoff: datetime) -> int:
        """Delete old task completions and return the number of rows removed."""
        pass
