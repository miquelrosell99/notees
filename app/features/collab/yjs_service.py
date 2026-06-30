"""Domain service for Yjs CRDT state."""

from __future__ import annotations

from app.domain.errors import NodeNotFoundError, PermissionDeniedError
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
        node_id = await self._repository.resolve_node_id(node_uuid)
        if node_id is None:
            raise NodeNotFoundError(node_uuid)

        if not await self._permission_checker.can_read_node(node_id):
            raise PermissionDeniedError(
                f"User cannot read Yjs state for node {node_uuid}"
            )

        return await self._repository._get_state_by_node_id(node_id)

    async def apply_update(self, node_uuid: str, update_blob: bytes) -> bytes:
        """Append a Yjs update if the user can write the node.

        Returns the merged blob after concatenation.
        """
        node_id = await self._repository.resolve_node_id(node_uuid)
        if node_id is None:
            raise NodeNotFoundError(node_uuid)

        if not await self._permission_checker.can_write_node(node_id):
            raise PermissionDeniedError(
                f"User cannot update Yjs state for node {node_uuid}"
            )

        return await self._repository._apply_update_by_node_id(node_id, update_blob)
