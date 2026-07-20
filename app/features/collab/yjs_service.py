"""Domain service for Yjs CRDT state."""

from __future__ import annotations

from app.domain.errors import PermissionDeniedError
from app.domain.permissions import PermissionChecker

from .yjs_repository import PostgresYjsRepository


class YjsService:
    """Coordinates Yjs state reads/writes with permission checks."""

    def __init__(
        self,
        repository: PostgresYjsRepository,
        permission_checker: PermissionChecker,
    ) -> None:
        self._repository = repository
        self._permission_checker = permission_checker

    async def get_state(self, node_uuid: str) -> bytes | None:
        """Return the current Yjs state blob if the user can read the node."""
        if not await self._permission_checker.can_read_node(node_uuid):
            raise PermissionDeniedError(f"User cannot read Yjs state for node {node_uuid}")

        return await self._repository.get_state(node_uuid)

    async def apply_update(self, node_uuid: str, update_blob: bytes) -> bytes:
        """Append a Yjs update if the user can write the node.

        Returns the merged blob after concatenation.
        """
        if not await self._permission_checker.can_write_node(node_uuid):
            raise PermissionDeniedError(f"User cannot update Yjs state for node {node_uuid}")

        return await self._repository.apply_update(node_uuid, update_blob)
