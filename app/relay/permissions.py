"""Permission-checking port and Phase 1 stub for the operation relay."""

from __future__ import annotations

from abc import ABC, abstractmethod


class PermissionDeniedError(Exception):
    """Raised when the actor is not allowed to read or write operations."""


class PermissionChecker(ABC):
    """Abstract port for workspace/node-level permission checks."""

    @abstractmethod
    def can_write(
        self,
        workspace_id: str,
        actor_id: str,
        affected_node_ids: list[str],
    ) -> bool:
        """Return ``True`` if ``actor_id`` may write the given operation."""

    @abstractmethod
    def can_read(self, workspace_id: str, actor_id: str) -> bool:
        """Return ``True`` if ``actor_id`` may read operations for ``workspace_id``."""


class StubPermissionChecker(PermissionChecker):
    """Permission checker that always allows.

    This stub satisfies Phase 1 unit tests while the real membership/share
    integration is deferred to Phase 5.
    """

    def can_write(
        self,
        workspace_id: str,
        actor_id: str,
        affected_node_ids: list[str],
    ) -> bool:
        return True

    def can_read(self, workspace_id: str, actor_id: str) -> bool:
        return True
