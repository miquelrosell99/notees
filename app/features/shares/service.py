"""Public share domain service.

This service now operates only on the PostgreSQL share metadata tables.  Node
existence and display-name resolution are handled by callers that read from the
operation-log derived state via :class:`app.core.workspace_store.WorkspaceStore`.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from app.domain.entities.share import PublicShare
from app.domain.ports import EmailSender, InviteEmailResult
from app.features.export.service import ExportService
from app.logging_config import get_logger

from .port import ShareRepository

logger = get_logger(__name__)


class ShareService:
    """Domain service for public share link operations."""

    def __init__(
        self,
        share_repository: ShareRepository,
        node_export_service: ExportService,
        workspace_id: int,
        user_id: int,
        email_sender: EmailSender | None = None,
    ):
        self._share_repo = share_repository
        self._node_export_service = node_export_service
        self._workspace_id = workspace_id
        self._user_id = user_id
        self._email_sender = email_sender

    async def create_share(
        self,
        node_uuid: str,
        expiry_date: str | None = None,
    ) -> PublicShare:
        """Create a new public share for a node."""
        share = await self._share_repo.create_share(
            node_uuid=node_uuid,
            workspace_id=self._workspace_id,
            created_by=self._user_id,
            expiry_date=expiry_date,
        )
        logger.info(f"Created public share {share.uuid} for node {node_uuid}")
        return share

    async def list_shares_for_node(self, node_uuid: str) -> list[PublicShare]:
        """List all active shares for a node."""
        return await self._share_repo.list_shares_for_node(node_uuid)

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

    async def get_shared_node(self, share_uuid: str) -> dict[str, Any] | None:
        """Get publicly shared node metadata by its share UUID."""
        share = await self._share_repo.get_share_by_uuid(share_uuid)
        if share is None or not share.is_valid():
            return None
        return await self._share_repo.get_shared_node(share_uuid)

    async def get_share_by_uuid(self, share_uuid: str) -> PublicShare | None:
        """Get share metadata by UUID."""
        return await self._share_repo.get_share_by_uuid(share_uuid)

    async def create_node_user_share(
        self,
        node_uuid: str,
        node_name: str | None,
        email: str,
        permission: str,
    ) -> dict[str, Any]:
        """Share a node with a specific user, sending an invite if needed."""
        result = await self._share_repo.create_node_user_share(
            node_uuid, self._workspace_id, self._user_id, email, permission
        )
        if result is None:
            return {"status": "error", "detail": "Failed to create share"}

        if result.get("status") != "pending":
            return {
                "share_id": result["id"],
                "uuid": str(result["uuid"]),
                "node_uuid": result["node_uuid"],
                "shared_with_user_id": result["user_id"],
                "shared_with_user_uuid": str(result.get("user_uuid", "")),
                "shared_with_email": email,
                "permission": "write" if result["can_write"] else "read",
                "created_at": result["create_date"].isoformat() if result["create_date"] else None,
                "created_by": result["create_uid"],
                "created_by_uuid": str(result.get("create_user_uuid", "")),
            }

        invite_result: InviteEmailResult | None = None
        if self._email_sender is not None:
            invite_result = await self._email_sender.send_invite(
                recipient=email,
                inviter_name="",
                workspace_name=None,
                node_name=node_name,
                invite_token=result["invite_token"],
            )

        return {
            "status": "pending",
            "email": email,
            "invite_link": (
                invite_result.invite_url if invite_result is not None else None
            ),
        }

    async def write_share_html(self, share_uuid: str, node_uuid: str) -> Path:
        """Generate and write static share HTML for a node."""
        return await self._node_export_service.write_share_html(
            share_uuid, self._workspace_id, node_uuid
        )

    async def regenerate_share_html_for_node(self, node_uuid: str) -> None:
        """Regenerate static share HTML for all active shares of a node."""
        shares = await self._share_repo.list_shares_for_node(node_uuid)
        for share in shares:
            if not share.active:
                continue
            try:
                await self.write_share_html(str(share.uuid), node_uuid)
            except (OSError, ValueError):
                logger.exception("Failed to regenerate share HTML for %s", share.uuid)
