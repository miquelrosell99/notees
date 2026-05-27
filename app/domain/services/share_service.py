"""Public share domain service."""

from __future__ import annotations

from ...logging_config import get_logger
from ..entities import Node
from ..entities.share import PublicShare
from ..repositories.interfaces import NodeRepository, ShareRepository

logger = get_logger(__name__)


class ShareService:
    """Domain service for public share link operations."""

    def __init__(
        self,
        share_repository: ShareRepository,
        node_repository: NodeRepository,
        workspace_id: int,
        user_id: int,
    ):
        self._share_repo = share_repository
        self._node_repo = node_repository
        self._workspace_id = workspace_id
        self._user_id = user_id

    async def create_share(
        self,
        node_id: int,
        expiry_date: str | None = None,
    ) -> PublicShare:
        """Create a new public share for a node."""
        # Verify node exists and belongs to workspace
        node = await self._node_repo.get_by_id(node_id)
        if node is None or node.workspace_id != self._workspace_id:
            raise ValueError("Node not found")

        share = await self._share_repo.create_share(
            node_id=node_id,
            workspace_id=self._workspace_id,
            created_by=self._user_id,
            expiry_date=expiry_date,
        )
        logger.info(f"Created public share {share.uuid} for node {node_id}")
        return share

    async def list_shares_for_node(self, node_id: int) -> list[PublicShare]:
        """List all active shares for a node."""
        return await self._share_repo.list_shares_for_node(node_id)

    async def list_workspace_shares(self) -> list[PublicShare]:
        """List all active shares in the workspace."""
        return await self._share_repo.list_shares_for_workspace(self._workspace_id)

    async def delete_share(self, share_uuid: str) -> bool:
        """Revoke a share."""
        share = await self._share_repo.get_share_by_uuid(share_uuid)
        if share is None:
            return False
        if share.workspace_id != self._workspace_id:
            raise PermissionError("Share does not belong to this workspace")
        success = await self._share_repo.delete_share(share_uuid)
        if success:
            logger.info(f"Revoked public share {share_uuid}")
        return success

    async def get_shared_node(self, share_uuid: str) -> Node | None:
        """Get a publicly shared node by its share UUID."""
        share = await self._share_repo.get_share_by_uuid(share_uuid)
        if share is None or not share.is_valid():
            return None
        return await self._share_repo.get_shared_node(share_uuid)

    async def get_share_by_uuid(self, share_uuid: str) -> PublicShare | None:
        """Get share metadata by UUID."""
        return await self._share_repo.get_share_by_uuid(share_uuid)
