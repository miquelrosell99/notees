"""Workspace key-management service.

This service wraps :class:`WorkspaceKeyStorage` with workspace membership and
admin checks. It is a *prototype* server-side key-management scheme; Phase 6
should move to true client-side key generation for full E2EE.
"""

from __future__ import annotations

from typing import Any

from app.config import settings
from app.db.connection import get_connection
from app.relay.key_storage import WorkspaceKeyStorage


class PermissionDeniedError(Exception):
    """Raised when an actor is not authorized for a key-management operation."""


class KeyManagementService:
    """Service for retrieving, provisioning, and rotating workspace keys."""

    def __init__(self, storage: WorkspaceKeyStorage | None = None) -> None:
        self._storage = storage or WorkspaceKeyStorage()

    async def get_key(
        self,
        workspace_id: str,
        actor_id: str,
    ) -> dict[str, Any]:
        """Return the wrapped workspace key for the authenticated actor.

        Raises:
            PermissionDeniedError: If the actor is not a workspace member.
        """
        user_id = await self._resolve_user_id(actor_id)
        if user_id is None:
            raise PermissionDeniedError("Authentication required")

        if not await self._is_member(workspace_id, user_id):
            raise PermissionDeniedError("Not a workspace member")

        return await self._storage.get_wrapped_key_for_user(
            workspace_id,
            actor_id,
            settings.secret_key,
        )

    async def invite_member(
        self,
        workspace_id: str,
        actor_id: str,
        target_user_id: str,
    ) -> dict[str, Any]:
        """Provision a wrapped key for ``target_user_id``.

        Only the workspace owner or an admin may invite members. If the target
        user is not already a workspace member, they are added as a viewer.

        Raises:
            PermissionDeniedError: If the actor is not an owner/admin.
            ValueError: If the target user does not exist.
        """
        actor_internal_id = await self._resolve_user_id(actor_id)
        if actor_internal_id is None:
            raise PermissionDeniedError("Authentication required")

        if not await self._is_owner_or_admin(workspace_id, actor_internal_id):
            raise PermissionDeniedError("Owner or admin access required")

        target_internal_id = await self._resolve_user_id(target_user_id)
        if target_internal_id is None:
            raise ValueError(f"User {target_user_id} not found")

        if not await self._is_member(workspace_id, target_internal_id):
            await self._add_member(workspace_id, target_internal_id, actor_internal_id)

        return await self._storage.get_wrapped_key_for_user(
            workspace_id,
            target_user_id,
            settings.secret_key,
        )

    async def rotate_key(
        self,
        workspace_id: str,
        actor_id: str,
    ) -> dict[str, Any]:
        """Rotate the workspace master key.

        Only the workspace owner or an admin may rotate the key.

        Raises:
            PermissionDeniedError: If the actor is not an owner/admin.
        """
        actor_internal_id = await self._resolve_user_id(actor_id)
        if actor_internal_id is None:
            raise PermissionDeniedError("Authentication required")

        if not await self._is_owner_or_admin(workspace_id, actor_internal_id):
            raise PermissionDeniedError("Owner or admin access required")

        await self._storage.rotate_master_key(workspace_id, settings.secret_key)

        # Fetch the updated version for the response.
        async with get_connection() as conn:
            row = await conn.fetchrow(
                "SELECT version FROM workspace_key WHERE workspace_id = $1",
                workspace_id,
            )
        if row is None:
            raise RuntimeError("Workspace key missing after rotation")

        return {
            "workspace_id": workspace_id,
            "key_version": row["version"],
        }

    async def _resolve_user_id(self, actor_id: str) -> int | None:
        """Map a public user UUID to the internal numeric user id."""
        async with get_connection() as conn:
            row = await conn.fetchrow(
                'SELECT id FROM "user" WHERE uuid::text = $1 AND active = TRUE',
                actor_id,
            )
            return row["id"] if row else None

    async def _is_owner_or_admin(self, workspace_id: str, user_id: int) -> bool:
        """Return ``True`` if ``user_id`` is the owner or an admin of the workspace."""
        async with get_connection() as conn:
            row = await conn.fetchrow(
                """
                SELECT 1
                FROM workspace w
                WHERE w.uuid::text = $1 AND w.active = TRUE
                  AND (
                      w.create_uid = $2
                      OR EXISTS (
                          SELECT 1 FROM workspace_share gs
                          WHERE gs.workspace_id = w.id
                            AND gs.user_id = $2
                            AND gs.active = TRUE
                            AND gs.can_delete = TRUE
                      )
                  )
                """,
                workspace_id,
                user_id,
            )
            return row is not None

    async def _is_member(self, workspace_id: str, user_id: int) -> bool:
        """Return ``True`` if ``user_id`` is a member of the workspace."""
        async with get_connection() as conn:
            row = await conn.fetchrow(
                """
                SELECT 1
                FROM workspace w
                WHERE w.uuid::text = $1 AND w.active = TRUE
                  AND (
                      w.create_uid = $2
                      OR EXISTS (
                          SELECT 1 FROM workspace_share gs
                          WHERE gs.workspace_id = w.id
                            AND gs.user_id = $2
                            AND gs.active = TRUE
                      )
                  )
                """,
                workspace_id,
                user_id,
            )
            return row is not None

    async def _add_member(
        self,
        workspace_id: str,
        target_user_id: int,
        owner_id: int,
    ) -> None:
        """Add ``target_user_id`` as a viewer member of the workspace."""
        async with get_connection() as conn:
            workspace_row = await conn.fetchrow(
                "SELECT id FROM workspace WHERE uuid::text = $1 AND active = TRUE",
                workspace_id,
            )
            if workspace_row is None:
                raise ValueError(f"Workspace {workspace_id} not found")

            workspace_internal_id = workspace_row["id"]
            await conn.execute(
                """
                INSERT INTO workspace_share (
                    workspace_id, user_id, can_read, can_write, can_create, can_delete, can_comment,
                    active, create_uid, write_uid
                )
                VALUES ($1, $2, TRUE, FALSE, FALSE, FALSE, FALSE, TRUE, $3, $3)
                ON CONFLICT (workspace_id, user_id)
                DO UPDATE SET
                    can_read = EXCLUDED.can_read,
                    can_write = EXCLUDED.can_write,
                    can_create = EXCLUDED.can_create,
                    can_delete = EXCLUDED.can_delete,
                    can_comment = EXCLUDED.can_comment,
                    active = TRUE,
                    write_uid = EXCLUDED.write_uid,
                    write_date = NOW()
                """,
                workspace_internal_id,
                target_user_id,
                owner_id,
            )
            await conn.execute(
                "UPDATE workspace SET is_shared = TRUE WHERE id = $1",
                workspace_internal_id,
            )
