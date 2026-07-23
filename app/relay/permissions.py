"""Permission-checking port and Phase 1 stub for the operation relay."""

from __future__ import annotations

from abc import ABC, abstractmethod


class PermissionDeniedError(Exception):
    """Raised when the actor is not allowed to read or write operations."""


class PermissionChecker(ABC):
    """Abstract port for workspace/node-level permission checks."""

    @abstractmethod
    async def can_write(
        self,
        workspace_id: str,
        actor_id: str,
        affected_node_ids: list[str],
    ) -> bool:
        """Return ``True`` if ``actor_id`` may write the given operation."""

    @abstractmethod
    async def can_read(self, workspace_id: str, actor_id: str) -> bool:
        """Return ``True`` if ``actor_id`` may read operations for ``workspace_id``."""

    async def can_read_public_share(
        self,
        workspace_id: str,
        share_token: str,
        node_id: str | None = None,
    ) -> bool:
        """Return ``True`` if ``share_token`` grants read access.

        Default implementation always returns ``False``. Concrete adapters that
        support public-share tokens (e.g. :class:`PostgresPermissionChecker`)
        override this with real database checks.
        """
        return False

    async def get_public_share_node_id(
        self,
        workspace_id: str,
        share_token: str,
    ) -> str | None:
        """Return the node id a public share token grants access to, if any.

        Default implementation returns ``None``. Concrete adapters that support
        public-share tokens override this with a real database lookup.
        """
        return None


class StubPermissionChecker(PermissionChecker):
    """Permission checker that always allows.

    This stub satisfies Phase 1 unit tests while the real membership/share
    integration is deferred to Phase 5.
    """

    async def can_write(
        self,
        workspace_id: str,
        actor_id: str,
        affected_node_ids: list[str],
    ) -> bool:
        return True

    async def can_read(self, workspace_id: str, actor_id: str) -> bool:
        return True
