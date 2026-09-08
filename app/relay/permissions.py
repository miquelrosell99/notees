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

    async def can_write_batch(
        self,
        workspace_id: str,
        actor_id: str,
        affected_node_ids_batch: list[list[str]],
    ) -> bool:
        """Return ``True`` if ``actor_id`` may write every envelope in a batch.

        Default implementation loops :meth:`can_write`; adapters whose checks
        are workspace-scoped (node ids unused) should override with a single
        query per batch instead of two queries per envelope.
        """
        for affected_node_ids in affected_node_ids_batch:
            if not await self.can_write(workspace_id, actor_id, affected_node_ids):
                return False
        return True

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
