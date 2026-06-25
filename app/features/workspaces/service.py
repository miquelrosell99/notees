"""Domain service for workspace lifecycle and membership operations."""

from __future__ import annotations

from typing import Any

from app.domain.ports import EmailSender
from app.features.auth.port import UserRepository
from app.features.workspaces.port import WorkspaceRepository

# Track active workspace per user (in-memory, for session)
# Maps user_id (str) -> workspace UUID (str)
_active_workspaces: dict[str, str] = {}


class WorkspaceService:
    """Orchestrates workspace CRUD, seeding, and user-page creation."""

    def __init__(
        self,
        workspace_repo: WorkspaceRepository,
        user_repo: UserRepository,
        email_sender: EmailSender | None = None,
    ):
        self._workspace_repo = workspace_repo
        self._user_repo = user_repo
        self._email_sender = email_sender

    @staticmethod
    def get_active_workspace_id(user_id: str) -> str | None:
        """Get the active workspace UUID for a user."""
        return _active_workspaces.get(user_id)

    @staticmethod
    def set_active_workspace(user_id: str, workspace_uuid: str) -> None:
        """Set the active workspace UUID for a user."""
        _active_workspaces[user_id] = workspace_uuid

    @staticmethod
    def clear_active_workspace(user_id: str) -> None:
        """Clear the active workspace UUID for a user."""
        _active_workspaces.pop(user_id, None)

    async def _get_numeric_user_id(self, user_id: str) -> int | None:
        """Convert string user_id to numeric PostgreSQL ID."""
        user = await self._user_repo.get_by_id_or_uuid(user_id)
        return int(user.id) if user else None

    async def list_workspaces(self, user_id: str) -> list[dict[str, Any]]:
        """List all workspaces accessible to a user (owned + shared)."""
        numeric_user_id = await self._get_numeric_user_id(user_id)
        if not numeric_user_id:
            return []

        rows = await self._workspace_repo.list_workspaces(numeric_user_id)
        active_uuid = self.get_active_workspace_id(user_id)
        result = []
        for row in rows:
            if row["is_owner"]:
                role = "owner"
            elif row["s_can_delete"]:
                role = "admin"
            elif row["s_can_write"]:
                role = "editor"
            else:
                role = "viewer"
            result.append(
                {
                    "uuid": str(row["uuid"]),
                    "name": row["name"],
                    "created_at": row["create_date"].isoformat() if row["create_date"] else None,
                    "updated_at": row["write_date"].isoformat() if row["write_date"] else None,
                    "is_shared": row["is_shared"],
                    "role": role,
                    "is_active": str(row["uuid"]) == active_uuid,
                }
            )
        return result

    async def create_workspace(self, user_id: str, name: str) -> dict[str, Any]:
        """Create a new workspace for a user."""
        numeric_user_id = await self._get_numeric_user_id(user_id)
        if not numeric_user_id:
            raise ValueError(f"User not found: {user_id}")

        existing = await self._workspace_repo.get_by_name_and_owner(name, numeric_user_id)
        if existing:
            raise ValueError(f"Workspace '{name}' already exists")

        row = await self._workspace_repo.create(name, numeric_user_id)
        if row is None:
            raise RuntimeError("Failed to create workspace")

        workspace_id = row["id"]
        await self._workspace_repo.seed_workspace(workspace_id, numeric_user_id)
        await self._workspace_repo.ensure_user_page(workspace_id, numeric_user_id)

        self.set_active_workspace(user_id, str(row["uuid"]))
        return {
            "uuid": str(row["uuid"]),
            "name": row["name"],
            "created_at": row["create_date"].isoformat() if row["create_date"] else None,
        }

    async def switch_workspace(self, user_id: str, workspace_uuid: str) -> bool:
        """Switch to a different workspace. Returns True on success."""
        numeric_user_id = await self._get_numeric_user_id(user_id)
        if not numeric_user_id:
            return False

        workspace = await self._workspace_repo.get_by_uuid_for_user(
            workspace_uuid, numeric_user_id
        )
        if not workspace:
            return False

        self.set_active_workspace(user_id, workspace_uuid)
        return True

    async def rename_workspace(
        self, user_id: str, old_name: str, new_name: str
    ) -> dict[str, Any]:
        """Rename a workspace (owner only)."""
        numeric_user_id = await self._get_numeric_user_id(user_id)
        if not numeric_user_id:
            raise ValueError(f"User not found: {user_id}")

        old_workspace = await self._workspace_repo.get_by_name_and_owner(
            old_name, numeric_user_id
        )
        if not old_workspace:
            raise ValueError(f"Workspace '{old_name}' not found")

        existing = await self._workspace_repo.get_by_name_and_owner(
            new_name, numeric_user_id
        )
        if existing:
            raise ValueError(f"Workspace '{new_name}' already exists")

        row = await self._workspace_repo.rename(
            old_workspace["id"], new_name, numeric_user_id
        )
        if row is None:
            raise RuntimeError("Failed to rename workspace")

        active_uuid = self.get_active_workspace_id(user_id)
        if active_uuid and str(row["uuid"]) == active_uuid:
            # Name change doesn't invalidate the UUID mapping.
            pass

        return {
            "uuid": str(row["uuid"]),
            "name": row["name"],
            "created_at": row["create_date"].isoformat() if row["create_date"] else None,
        }

    async def delete_workspace(self, user_id: str, workspace_uuid: str) -> bool:
        """Delete a workspace (owner only)."""
        numeric_user_id = await self._get_numeric_user_id(user_id)
        if not numeric_user_id:
            return False

        workspace_id = await self._workspace_repo.get_id_by_uuid_and_owner(
            workspace_uuid, numeric_user_id
        )
        if not workspace_id:
            return False

        deleted = await self._workspace_repo.delete_cascade(workspace_id)
        if deleted:
            self.clear_active_workspace(user_id)
        return deleted

    # -------------------------------------------------------------------------
    # Membership and invite orchestration
    # -------------------------------------------------------------------------

    async def get_workspace_uuid_by_name(self, name: str, user_id: int) -> str | None:
        """Resolve a workspace UUID from its name for a user."""
        return await self._workspace_repo.get_workspace_uuid_by_name_for_user(name, user_id)

    async def invite_member(
        self,
        workspace_uuid: str,
        owner_id: int,
        email: str,
        role: str,
        inviter_name: str,
    ) -> dict[str, Any]:
        """Invite a user to a workspace by email.

        If the user already exists, add them via workspace_share.  Otherwise
        create a pending_invite and optionally send an email.
        """
        ws = await self._workspace_repo.get_workspace_id_owner(workspace_uuid)
        if not ws:
            raise ValueError("Workspace not found")
        ws_id, ws_owner_id = ws
        if ws_owner_id != owner_id:
            raise PermissionError("Only workspace owners can invite members")

        target = await self._user_repo.get_by_email(email)
        if target and target.id is not None:
            if target.id == owner_id:
                raise ValueError("Cannot invite yourself")

            await self._workspace_repo.invite_existing_member(ws_id, target.id, role, owner_id)
            return {"status": "ok", "email": email, "role": role}

        invite_uuid = await self._workspace_repo.create_pending_invite(
            ws_id, email, role, owner_id
        )

        if self._email_sender is None:
            return {
                "status": "pending",
                "email": email,
                "role": role,
                "invite_link": None,
            }

        result = await self._email_sender.send_invite(
            recipient=email,
            inviter_name=inviter_name,
            workspace_name=workspace_uuid,
            node_name=None,
            invite_token=invite_uuid,
        )
        return {
            "status": "pending",
            "email": email,
            "role": role,
            "invite_link": None if result.sent else result.invite_url,
        }

    async def list_members(
        self, workspace_uuid: str, user_id: int, page: int, page_size: int
    ) -> dict[str, Any]:
        """List members of a workspace."""
        ws = await self._workspace_repo.get_workspace_id_owner(workspace_uuid)
        if not ws:
            raise ValueError("Workspace not found")
        ws_id, owner_id = ws

        is_owner = owner_id == user_id
        if not is_owner and not await self._workspace_repo.is_workspace_member(ws_id, user_id):
            raise PermissionError("Not a member of this workspace")

        result = await self._workspace_repo.list_members(ws_id, page, page_size)
        owner_row = result["owner"]
        rows = result["members"]
        pending_rows = result["pending"]
        offset = result["offset"]

        members = []
        if owner_row and offset == 0:
            members.append(
                {
                    "user_id": owner_row["id"],
                    "email": owner_row["email"],
                    "user_uuid": str(owner_row["user_uuid"]),
                    "role": "owner",
                    "joined_at": None,
                }
            )
        for r in rows:
            role = "viewer"
            if r["can_delete"]:
                role = "admin"
            elif r["can_write"]:
                role = "editor"
            elif r["can_comment"]:
                role = "commenter"
            members.append(
                {
                    "user_id": r["id"],
                    "email": r["email"],
                    "user_uuid": str(r["user_uuid"]),
                    "share_uuid": str(r["share_uuid"]) if r.get("share_uuid") else None,
                    "role": role,
                    "joined_at": r["create_date"].isoformat() if r["create_date"] else None,
                }
            )
        for p in pending_rows:
            members.append(
                {
                    "user_id": None,
                    "email": p["email"],
                    "user_uuid": None,
                    "invite_uuid": str(p["invite_uuid"]) if p.get("invite_uuid") else None,
                    "role": p["role"],
                    "joined_at": None,
                    "status": "pending",
                }
            )
        return {"members": members}

    async def update_member(
        self,
        workspace_uuid: str,
        owner_id: int,
        member_user_id: int,
        role: str,
    ) -> None:
        """Update a member's role in a workspace."""
        ws = await self._workspace_repo.get_workspace_id_owner(workspace_uuid)
        if not ws:
            raise ValueError("Workspace not found")
        ws_id, ws_owner_id = ws
        if ws_owner_id != owner_id:
            raise PermissionError("Only workspace owners can update members")
        if member_user_id == ws_owner_id:
            raise ValueError("Cannot change owner's role")

        updated = await self._workspace_repo.update_member_role(ws_id, member_user_id, role, owner_id)
        if not updated:
            raise ValueError("Member not found")

    async def remove_member(
        self,
        workspace_uuid: str,
        owner_id: int,
        member_user_id: int,
    ) -> None:
        """Remove a member from a workspace."""
        ws = await self._workspace_repo.get_workspace_id_owner(workspace_uuid)
        if not ws:
            raise ValueError("Workspace not found")
        ws_id, ws_owner_id = ws
        if ws_owner_id != owner_id:
            raise PermissionError("Only workspace owners can remove members")
        if member_user_id == ws_owner_id:
            raise ValueError("Cannot remove owner")

        await self._workspace_repo.remove_member(ws_id, member_user_id)

    async def remove_pending_invite(
        self,
        workspace_uuid: str,
        owner_id: int,
        email: str,
    ) -> None:
        """Cancel a pending invite by email."""
        ws = await self._workspace_repo.get_workspace_id_owner(workspace_uuid)
        if not ws:
            raise ValueError("Workspace not found")
        ws_id, ws_owner_id = ws
        if ws_owner_id != owner_id:
            raise PermissionError("Only workspace owners can remove invites")

        await self._workspace_repo.remove_pending_invite(ws_id, email)
