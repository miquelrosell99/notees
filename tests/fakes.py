"""Reusable in-memory fakes for backend unit tests.

These fakes implement the small surfaces of repository interfaces and domain
ports that domain services actually call. They keep unit tests fast by avoiding
PostgreSQL and Docker.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any

from app.domain.entities import (
    ClassExtend,
    ClassProperty,
    Node,
    NodeCreateData,
    NodeProperty,
    NodeUpdateData,
    Property,
    PropertyClassFilter,
    PropertySelectionLine,
    PropertyType,
    PropertyValueRelation,
    PropertyValueScalar,
    PropertyValueSelection,
    TaskCompletion,
    TaskRecurrence,
    User,
    generate_uuid,
)
from app.domain.entities.constants import SYSTEM_PROPERTY_UUIDS
from app.domain.entities.share import PublicShare
from app.domain.node_flags import compute_node_flags
from app.domain.ports import EmailSender, InviteEmailResult
from app.features.tasks.port import TaskCompletionRepository, TaskRecurrenceRepository
from app.utils import utc_now_iso


class FakeEmailSender(EmailSender):
    """Records send_invite calls and returns a configurable result."""

    def __init__(self, sent: bool = True, invite_url: str | None = None) -> None:
        self.sent = sent
        self.invite_url = invite_url
        self.calls: list[dict[str, Any]] = []

    async def send_invite(
        self,
        recipient: str,
        inviter_name: str,
        workspace_name: str | None,
        node_name: str | None,
        invite_token: str,
    ) -> InviteEmailResult:
        """Record the call and return a canned invite result."""
        self.calls.append(
            {
                "recipient": recipient,
                "inviter_name": inviter_name,
                "workspace_name": workspace_name,
                "node_name": node_name,
                "invite_token": invite_token,
            }
        )
        return InviteEmailResult(
            sent=self.sent,
            invite_url=self.invite_url or f"http://test/enroll?token={invite_token}",
        )


class FakeWorkspaceRepository:
    """In-memory workspace repository with just enough surface for invite tests."""

    def __init__(self) -> None:
        self._workspaces: dict[int, dict[str, Any]] = {}
        self._pending_invites: list[dict[str, Any]] = []
        self._members: list[dict[str, Any]] = []
        self._next_workspace_id = 1
        self._next_invite_id = 1
        self._next_member_id = 1

    def add_workspace(self, name: str, owner_id: int) -> dict[str, Any]:
        """Helper to seed a workspace row for tests."""
        workspace_id = self._next_workspace_id
        self._next_workspace_id += 1
        row = {
            "id": workspace_id,
            "uuid": generate_uuid(),
            "name": name,
            "owner_id": owner_id,
            "create_date": datetime.now(),
            "write_date": datetime.now(),
        }
        self._workspaces[workspace_id] = row
        return row

    async def get_by_id(self, workspace_id: int) -> dict[str, Any] | None:
        """Get a workspace row by internal ID."""
        return self._workspaces.get(workspace_id)

    async def get_by_uuid(self, workspace_uuid: str) -> dict[str, Any] | None:
        """Get a workspace row by UUID."""
        for row in self._workspaces.values():
            if str(row["uuid"]) == workspace_uuid:
                return row
        return None

    async def get_workspace_id_owner(
        self, workspace_uuid: str
    ) -> tuple[int, int] | None:
        """Return (workspace_id, owner_id) for an active workspace, or None."""
        row = await self.get_by_uuid(workspace_uuid)
        if row is None:
            return None
        return row["id"], row["owner_id"]

    async def create_pending_invite(
        self, workspace_id: int, email: str, role: str, invited_by: int
    ) -> str:
        """Create or refresh a pending invite and return its UUID token."""
        token = generate_uuid()
        self._pending_invites.append(
            {
                "id": self._next_invite_id,
                "workspace_id": workspace_id,
                "email": email,
                "role": role,
                "invited_by": invited_by,
                "token": token,
            }
        )
        self._next_invite_id += 1
        return token

    async def get_pending_invite(self, token: str) -> dict[str, Any] | None:
        """Get an active pending invite by its UUID token."""
        for invite in self._pending_invites:
            if invite["token"] == token:
                return invite
        return None

    @staticmethod
    def _role_to_permissions(role: str) -> dict[str, bool]:
        """Map a role name to workspace permission flags."""
        if role in ("owner", "admin"):
            return {"can_delete": True, "can_write": True, "can_comment": True}
        if role == "editor":
            return {"can_delete": False, "can_write": True, "can_comment": True}
        if role == "commenter":
            return {"can_delete": False, "can_write": False, "can_comment": True}
        return {"can_delete": False, "can_write": False, "can_comment": False}

    async def invite_existing_member(
        self, workspace_id: int, target_id: int, role: str, _owner_id: int
    ) -> None:
        """Upsert a workspace_share record for an existing user."""
        self._members.append(
            {
                "id": self._next_member_id,
                "workspace_id": workspace_id,
                "user_id": target_id,
                "active": True,
                "create_date": datetime.now(),
                **self._role_to_permissions(role),
            }
        )
        self._next_member_id += 1

    async def is_workspace_member(self, workspace_id: int, user_id: int) -> bool:
        """Return True if the user has an active workspace_share record."""
        return any(
            m["workspace_id"] == workspace_id
            and m["user_id"] == user_id
            and m["active"]
            for m in self._members
        )

    async def list_members(
        self, workspace_id: int, _page: int, _page_size: int
    ) -> dict[str, Any]:
        """Return owner, shared members, and pending invites for a workspace."""
        workspace = self._workspaces.get(workspace_id)
        owner = None
        if workspace:
            owner_user = next(
                (u for u in self._members if u["user_id"] == workspace["owner_id"]),
                None,
            )
            owner = {
                "id": workspace["owner_id"],
                "email": owner_user["email"] if owner_user else "owner@example.com",
                "user_uuid": generate_uuid(),
            }
        members = [m for m in self._members if m["workspace_id"] == workspace_id]
        pending = [
            {"email": i["email"], "role": i["role"]}
            for i in self._pending_invites
            if i["workspace_id"] == workspace_id
        ]
        return {
            "owner": owner,
            "members": members,
            "pending": pending,
            "offset": 0,
        }


class FakeUserRepository:
    """In-memory user repository with just enough surface for workspace tests."""

    def __init__(self) -> None:
        self._users: dict[int, User] = {}
        self._next_id = 1

    def add_user(
        self,
        email: str,
        password_hash: str = "",
        name: str | None = None,
        role: str = "user",
    ) -> User:
        """Helper to seed a user for tests."""
        user = User(
            id=self._next_id,
            email=email,
            password_hash=password_hash,
            name=name,
            role=role,
        )
        self._users[user.id] = user
        self._next_id += 1
        return user

    async def create(self, data: Any, password_hash: str) -> User:
        """Create a new user."""
        user = User(
            id=self._next_id,
            email=data.email,
            password_hash=password_hash,
            name=data.name,
            surnames=data.surnames,
            profile_pic=data.profile_pic,
            role=data.role,
        )
        self._users[user.id] = user
        self._next_id += 1
        return user

    async def get_by_id(self, user_id: int) -> User | None:
        """Get user by ID."""
        return self._users.get(user_id)

    async def get_by_id_or_uuid(self, user_id: str) -> User | None:
        """Get user by ID or UUID string."""
        try:
            return self._users.get(int(user_id))
        except ValueError:
            for user in self._users.values():
                if user.uuid == user_id:
                    return user
        return None

    async def get_by_email(self, email: str) -> User | None:
        """Get user by email address."""
        for user in self._users.values():
            if user.email == email:
                return user
        return None


class FakeShareRepository:
    """In-memory share repository with just enough surface for ShareService tests."""

    def __init__(self, users_by_email: dict[str, User] | None = None) -> None:
        self._users_by_email = users_by_email or {}
        self._shares: dict[int, PublicShare] = {}
        self._node_user_shares: list[dict[str, Any]] = []
        self._next_share_id = 1
        self._next_node_share_id = 1

    async def create_share(
        self,
        node_id: int,
        workspace_id: int,
        created_by: int,
        expiry_date: str | None = None,
    ) -> PublicShare:
        """Create a new public share for a node."""
        share = PublicShare(
            id=self._next_share_id,
            uuid=generate_uuid(),
            node_id=node_id,
            workspace_id=workspace_id,
            created_by=created_by,
            expiry_date=expiry_date,
        )
        self._shares[share.id] = share
        self._next_share_id += 1
        return share

    async def get_share_by_uuid(self, share_uuid: str) -> PublicShare | None:
        """Get a share by its UUID token."""
        for share in self._shares.values():
            if share.uuid == share_uuid:
                return share
        return None

    async def list_shares_for_node(self, node_id: int) -> list[PublicShare]:
        """List all active shares for a node."""
        return [s for s in self._shares.values() if s.node_id == node_id and s.active]

    async def list_shares_for_workspace(self, workspace_id: int) -> list[PublicShare]:
        """List all active shares in a workspace."""
        return [
            s for s in self._shares.values() if s.workspace_id == workspace_id and s.active
        ]

    async def delete_share(self, share_uuid: str) -> bool:
        """Revoke (soft-delete) a share by its UUID."""
        share = await self.get_share_by_uuid(share_uuid)
        if share is None:
            return False
        share.active = False
        return True

    async def get_shared_node(self, share_uuid: str) -> Node | None:
        """Get the node associated with a valid share."""
        share = await self.get_share_by_uuid(share_uuid)
        if share is None:
            return None
        return Node(id=share.node_id, name="Shared node")

    async def set_share_password(self, share_id: int, password_hash: str) -> None:
        """Set a password hash on a public share."""
        share = self._shares.get(share_id)
        if share is not None:
            share.password_hash = password_hash

    async def list_share_inbox(
        self, _user_id: int, _page: int, _page_size: int
    ) -> tuple[int, list[Any]]:
        """Get paginated node shares for a user."""
        return (0, [])

    async def create_node_user_share(
        self,
        node_id: int,
        workspace_id: int,
        user_id: int,
        target_email: str,
        permission: str,
    ) -> dict[str, Any] | None:
        """Create or update a node-level user share.

        Returns a pending dict when the user is not known, otherwise a direct
        share dict.
        """
        target = self._users_by_email.get(target_email)
        if target is None:
            return {
                "status": "pending",
                "invite_token": generate_uuid(),
            }

        share_row = {
            "id": self._next_node_share_id,
            "node_id": node_id,
            "user_id": target.id,
            "can_write": permission == "write",
            "create_date": datetime.now(),
            "create_uid": user_id,
        }
        self._node_user_shares.append(share_row)
        self._next_node_share_id += 1
        return share_row

    async def list_node_user_shares(
        self, _node_id: int, _workspace_id: int, _user_id: int
    ) -> tuple[bool, list[Any]]:
        """List user shares for a node."""
        return (True, [])

    async def revoke_user_share(
        self, share_id: int, _workspace_id: int, _user_id: int
    ) -> dict[str, Any] | None:
        """Revoke a node user share."""
        for share in self._node_user_shares:
            if share["id"] == share_id:
                return {"node_id": share["node_id"]}
        return None


class FakeNodeRepository:
    """In-memory node repository with enough surface for tag and task unit tests."""

    def __init__(self, nodes: dict[int, Node] | None = None) -> None:
        self._nodes: dict[int, Node] = dict(nodes) if nodes else {}
        self._next_id = max(self._nodes.keys(), default=0) + 1

    def _bump_id(self) -> int:
        nid = self._next_id
        self._next_id += 1
        return nid

    def add_node(self, node: Node) -> Node:
        """Seed a node; assigns an ID if missing."""
        if node.id is None:
            node.id = self._bump_id()
        self._nodes[node.id] = node
        return node

    async def create(
        self, data: NodeCreateData, user_id: int | None = None, uuid: str | None = None
    ) -> Node:
        """Create and store a new Node entity."""
        node = Node(
            id=self._bump_id(),
            uuid=uuid or data.uuid or generate_uuid(),
            name=data.name or "",
            icon=data.icon,
            color=data.color,
            parent_id=data.parent_id,
            sequence=data.sequence,
            class_ids=list(data.classes or []),
            tag_ids=list(data.tags or []),
            create_date=utc_now_iso(),
            write_date=utc_now_iso(),
            create_uid=user_id,
            write_uid=user_id,
        )
        class_nodes = [self._nodes[cid] for cid in node.class_ids if cid in self._nodes]
        flags = compute_node_flags(class_nodes)
        for flag_name, flag_value in flags.items():
            setattr(node, flag_name, flag_value)
        self._nodes[node.id] = node
        return node

    async def get_by_id(self, node_id: int) -> Node | None:
        """Get an active (non-deleted) node by ID."""
        node = self._nodes.get(node_id)
        if node is None or node.is_deleted:
            return Node(id=node_id, name="Test Node")
        return node

    async def get_by_ids(self, node_ids: list[int]) -> list[Node]:
        """Get multiple active nodes by ID."""
        return [
            self._nodes[nid]
            for nid in node_ids
            if nid in self._nodes and not self._nodes[nid].is_deleted
        ]

    async def get_by_uuid(self, uuid: str) -> Node | None:
        """Get an active node by UUID."""
        for node in self._nodes.values():
            if node.uuid == uuid and not node.is_deleted:
                return node
        return None

    async def get_node_by_id_with_workspace(self, node_id: int) -> Node | None:
        """Same as get_by_id for in-memory tests (no workspace gate)."""
        return await self.get_by_id(node_id)

    async def update(
        self, node_id: int, data: NodeUpdateData, user_id: int | None = None
    ) -> Node | None:
        """Apply a partial update to a node."""
        node = self._nodes.get(node_id)
        if node is None:
            return None
        if data.name is not None:
            node.name = data.name
        if data.icon is not None:
            node.icon = data.icon
        if data.color is not None:
            node.color = data.color
        if data.parent_id is not None:
            node.parent_id = data.parent_id
        if data.sequence is not None:
            node.sequence = data.sequence
        if data.is_private is not None:
            node.is_private = data.is_private
        if data.classes is not None:
            node.class_ids = list(data.classes)
            class_nodes = [self._nodes[cid] for cid in node.class_ids if cid in self._nodes]
            flags = compute_node_flags(class_nodes)
            for flag_name, flag_value in flags.items():
                setattr(node, flag_name, flag_value)
        node.touch(user_id)
        return node

    async def soft_delete_nodes(
        self, node_ids: list[int], deleted_at: str, write_uid: int | None = None
    ) -> None:
        """Soft-delete nodes and purge their IDs from all tag_ids arrays."""
        for nid in node_ids:
            node = self._nodes.get(nid)
            if node is not None:
                node.is_deleted = True
                node.deleted_at = deleted_at
                node.write_uid = write_uid
        self._remove_tag_ids_from_all_nodes(set(node_ids))

    def _remove_tag_ids_from_all_nodes(self, tag_ids: set[int]) -> None:
        for node in self._nodes.values():
            if not node.is_deleted:
                node.tag_ids = [tid for tid in node.tag_ids if tid not in tag_ids]

    async def hard_delete_nodes(self, node_ids: list[int]) -> None:
        """Permanently remove nodes from memory."""
        for nid in node_ids:
            self._nodes.pop(nid, None)

    async def delete(self, node_id: int) -> bool:
        """Hard-delete a single node."""
        if node_id not in self._nodes:
            return False
        del self._nodes[node_id]
        self._remove_tag_ids_from_all_nodes({node_id})
        return True

    async def get_descendants(self, node_id: int, include_self: bool = False) -> list[int]:
        return []

    async def get_all_descendants(
        self, node_id: int, include_self: bool = False
    ) -> list[int]:
        result = []
        if include_self and node_id in self._nodes:
            result.append(node_id)
        return result

    async def get_node_tag_ids(self, node_id: int) -> list[int]:
        node = self._nodes.get(node_id)
        if node is None:
            return []
        return list(node.tag_ids)

    async def update_node_tag_ids(self, node_id: int, tag_ids: list[int]) -> None:
        node = self._nodes.get(node_id)
        if node is not None:
            node.tag_ids = list(tag_ids)

    async def get_tag_ids_batch(self, node_ids: list[int]) -> dict[int, list[int]]:
        return {
            nid: list(self._nodes[nid].tag_ids)
            for nid in node_ids
            if nid in self._nodes and not self._nodes[nid].is_deleted
        }

    async def remove_tag_id_from_all_nodes(self, tag_id: int) -> int:
        count = 0
        for node in self._nodes.values():
            if tag_id in node.tag_ids:
                node.tag_ids = [tid for tid in node.tag_ids if tid != tag_id]
                count += 1
        return count

    async def redirect_tag_ids(self, old_tag_id: int, new_tag_id: int) -> int:
        count = 0
        for node in self._nodes.values():
            if old_tag_id in node.tag_ids:
                node.tag_ids = [
                    new_tag_id if tid == old_tag_id else tid for tid in node.tag_ids
                ]
                count += 1
        return count

    async def find_page_by_name(
        self, name: str, parent_id: int | None = None
    ) -> list[Any]:
        rows: list[dict[str, Any]] = []
        for node in self._nodes.values():
            if node.is_deleted:
                continue
            if node.is_page and node.name == name and node.parent_id == parent_id:
                for cid in node.class_ids:
                    class_node = self._nodes.get(cid)
                    rows.append(
                        {
                            "id": node.id,
                            "class_id": cid,
                            "class_name": class_node.name if class_node else "",
                        }
                    )
        return rows

    async def list_classes(self) -> list[Node]:
        return [n for n in self._nodes.values() if n.is_class and not n.is_deleted]

    async def get_page_id_by_uuid(self, uuid: str) -> int | None:
        node = await self.get_by_uuid(uuid)
        if node and node.is_page:
            return node.id
        return None

    async def get_children(self, parent_id: int, limit: int = 5000) -> list[Node]:
        return []

    async def get_page_content(self, page_id: int, limit: int = 5000) -> list[Node]:
        return []

    async def filter_existing_active_node_ids(self, node_ids: list[int]) -> set[int]:
        return {
            nid
            for nid in node_ids
            if nid in self._nodes and not self._nodes[nid].is_deleted
        }

    async def get_page_node_check(self, node_id: int) -> dict[str, Any] | None:
        node = self._nodes.get(node_id)
        if node is None or node.is_deleted:
            return None
        return {"id": node.id, "is_page": node.is_page}

    async def list_daily_pages_paginated(
        self, page: int, page_size: int
    ) -> tuple[int, list[Any]]:
        return (0, [])

    async def get_trash_paginated(
        self, page: int, page_size: int
    ) -> tuple[int, list[Any]]:
        return (0, [])

    async def move(
        self,
        node_id: int,
        new_parent_id: int | None = None,
        new_sequence: float | None = None,
        user_id: int | None = None,
    ) -> Node | None:
        return await self.update(
            node_id,
            NodeUpdateData(parent_id=new_parent_id, sequence=new_sequence),
            user_id,
        )

    async def get_ancestors(
        self, node_id: int, include_self: bool = False
    ) -> list[int]:
        return []

    async def get_ancestors_batch(
        self, node_ids: list[int], include_self: bool = False
    ) -> dict[int, list[int]]:
        return {nid: [] for nid in node_ids}

    async def get_descendants_batch(
        self, node_ids: list[int], include_self: bool = False
    ) -> dict[int, list[int]]:
        return {nid: [] for nid in node_ids}

    async def has_circular_reference(self, ancestor_id: int, descendant_id: int) -> bool:
        return False

    async def get_depth_info(self, node_id: int) -> tuple[int, int]:
        return (0, 0)

    async def find_node_id_by_uuid(self, uuid: str) -> int | None:
        node = await self.get_by_uuid(uuid)
        return node.id if node else None

    async def get_node_class_ids(self, node_id: int) -> list[int]:
        node = self._nodes.get(node_id)
        if node is None:
            return []
        return list(node.class_ids)

    async def update_node_class_ids(self, node_id: int, class_ids: list[int]) -> None:
        node = self._nodes.get(node_id)
        if node is not None:
            node.class_ids = list(class_ids)

    async def get_class_ids_batch(self, node_ids: list[int]) -> dict[int, list[int]]:
        return {
            nid: list(self._nodes[nid].class_ids)
            for nid in node_ids
            if nid in self._nodes and not self._nodes[nid].is_deleted
        }

    async def redirect_property_relation_targets(
        self, old_target_id: int, new_target_id: int
    ) -> int:
        return 0

    async def update_names_batch(
        self, updates: list[tuple[int, str]], user_id: int | None = None
    ) -> None:
        for node_id, new_name in updates:
            await self.update(node_id, NodeUpdateData(name=new_name), user_id)

    async def restore_nodes(
        self, node_ids: list[int], write_date: str, write_uid: int
    ) -> None:
        for nid in node_ids:
            node = self._nodes.get(nid)
            if node is not None:
                node.is_deleted = False
                node.deleted_at = None

    async def archive_nodes(
        self, node_ids: list[int], write_date: str, write_uid: int
    ) -> None:
        for nid in node_ids:
            node = self._nodes.get(nid)
            if node is not None:
                node.active = False

    async def unarchive_nodes(
        self, node_ids: list[int], write_date: str, write_uid: int
    ) -> None:
        for nid in node_ids:
            node = self._nodes.get(nid)
            if node is not None:
                node.active = True

    async def count_active_day_descendants(self, node_id: int) -> int:
        return 0


class FakeTaskRecurrenceRepository(TaskRecurrenceRepository):
    """In-memory recurrence rule store for domain-level tests."""

    def __init__(self) -> None:
        self._rules: dict[int, TaskRecurrence] = {}

    async def get_by_task(self, task_node_id: int) -> TaskRecurrence | None:
        return self._rules.get(task_node_id)

    async def upsert(self, data: TaskRecurrence) -> TaskRecurrence:
        self._rules[data.task_node_id] = data
        return data

    async def delete(self, task_node_id: int) -> bool:
        return self._rules.pop(task_node_id, None) is not None


class FakeTaskCompletionRepository(TaskCompletionRepository):
    """In-memory completion history store for domain-level tests."""

    def __init__(self) -> None:
        self._records: list[TaskCompletion] = []

    async def list_by_task(
        self, task_node_id: int, limit: int = 50, offset: int = 0
    ) -> list[TaskCompletion]:
        matching = [c for c in self._records if c.task_node_id == task_node_id]
        matching.sort(key=lambda c: c.completed_at, reverse=True)
        return matching[offset : offset + limit]

    async def create(self, completion: TaskCompletion) -> TaskCompletion:
        completion.id = len(self._records) + 1
        self._records.append(completion)
        return completion

    async def count_by_task(self, task_node_id: int) -> int:
        return sum(1 for c in self._records if c.task_node_id == task_node_id)

    async def get_by_uuid(self, completion_uuid: str) -> TaskCompletion | None:
        """Get a completion record by its public UUID."""
        for record in self._records:
            if record.uuid == completion_uuid:
                return record
        return None

    async def delete(self, completion_id: int) -> bool:
        before = len(self._records)
        self._records = [c for c in self._records if c.id != completion_id]
        return len(self._records) < before


class FakePropertyRepository:
    """In-memory property repository with system task properties pre-seeded."""

    def __init__(self) -> None:
        self._properties: dict[int, Property] = {}
        self._selection_lines: dict[int, list[PropertySelectionLine]] = {}
        self._values: dict[tuple[int, int], list[Any]] = {}
        self._next_id = 1
        self._next_value_id = 1
        self._seed_system_properties()

    def _bump_id(self) -> int:
        pid = self._next_id
        self._next_id += 1
        return pid

    def _bump_value_id(self) -> int:
        vid = self._next_value_id
        self._next_value_id += 1
        return vid

    def _seed_system_properties(self) -> None:
        self._add_property(
            SYSTEM_PROPERTY_UUIDS["task_status"], "Task Status", PropertyType.SELECTION, is_system=True
        )
        self._add_property(
            SYSTEM_PROPERTY_UUIDS["task_closed_date"], "Closed Date", PropertyType.DATE, is_system=True
        )
        self._add_property(
            SYSTEM_PROPERTY_UUIDS["task_recurrence"], "Recurrence", PropertyType.SELECTION, is_system=True
        )
        self._add_property(
            SYSTEM_PROPERTY_UUIDS["task_scheduled"], "Scheduled", PropertyType.DATE, is_system=True
        )
        self._add_property(
            SYSTEM_PROPERTY_UUIDS["task_deadline"], "Deadline", PropertyType.DATE, is_system=True
        )
        self._add_property(
            SYSTEM_PROPERTY_UUIDS["task_priority"], "Priority", PropertyType.SELECTION, is_system=True
        )

    def _add_property(
        self, uuid: str, name: str, prop_type: PropertyType, is_system: bool = False
    ) -> Property:
        prop = Property(
            id=self._bump_id(), uuid=uuid, name=name, type=prop_type, is_system=is_system
        )
        self._properties[prop.id] = prop
        return prop

    async def create(self, property: Property) -> Property:
        if property.id is None:
            property.id = self._bump_id()
        self._properties[property.id] = property
        return property

    async def get_by_id(self, property_id: int) -> Property | None:
        return self._properties.get(property_id)

    async def get_by_uuid(self, uuid: str) -> Property | None:
        for prop in self._properties.values():
            if prop.uuid == uuid:
                return prop
        return None

    async def get_by_uuids(self, uuids: list[str]) -> list[Property]:
        return [prop for prop in self._properties.values() if prop.uuid in uuids]

    async def get_by_name(self, name: str, node_id: int | None = None) -> Property | None:
        for prop in self._properties.values():
            if prop.name == name:
                return prop
        return None

    async def get_all(self, include_local: bool = True) -> list[Property]:
        return list(self._properties.values())

    async def get_local_properties(self, node_id: int) -> list[Property]:
        return []

    async def update(
        self, property_id: int, name: str | None = None, icon: str | None = None
    ) -> Property | None:
        prop = self._properties.get(property_id)
        if prop is None:
            return None
        if name is not None:
            prop.name = name
        if icon is not None:
            prop.icon = icon
        return prop

    async def can_delete_property(self, property_id: int) -> tuple[bool, str]:
        return (True, "")

    async def can_change_property_type(
        self, property_id: int, new_type: PropertyType
    ) -> tuple[bool, str]:
        return (True, "")

    async def change_property_type(
        self, property_id: int, new_type: PropertyType, new_is_multi: bool | None = None
    ) -> Property | None:
        prop = self._properties.get(property_id)
        if prop is None:
            return None
        prop.type = new_type
        if new_is_multi is not None:
            prop.is_multi = new_is_multi
        return prop

    async def delete(self, property_id: int) -> bool:
        return self._properties.pop(property_id, None) is not None

    async def assign_property_to_node(self, node_id: int, property_id: int) -> NodeProperty:
        return NodeProperty(node_id=node_id, property_id=property_id)

    async def get_node_property(
        self, node_id: int, property_id: int
    ) -> NodeProperty | None:
        prop = self._properties.get(property_id)
        return NodeProperty(
            node_id=node_id,
            property_id=property_id,
            property_type=prop.type if prop else None,
        )

    async def get_node_property_by_id(self, node_property_id: int) -> NodeProperty | None:
        return None

    async def get_node_properties(self, node_id: int) -> list[NodeProperty]:
        return []

    async def remove_property_from_node(self, node_id: int, property_id: int) -> bool:
        key = (node_id, property_id)
        if key in self._values:
            del self._values[key]
            return True
        return False

    async def get_node_ids_with_property(self, property_id: int) -> list[int]:
        return [nid for (nid, pid) in self._values if pid == property_id]

    async def set_scalar_value(
        self, node_id: int, property_id: int, value: Any
    ) -> PropertyValueScalar:
        scalar = PropertyValueScalar(
            id=self._bump_value_id(),
            node_property_id=0,
            property_id=property_id,
            node_id=node_id,
        )
        prop = self._properties.get(property_id)
        scalar.set_value(prop.type if prop else PropertyType.TEXT, value)
        self._values[(node_id, property_id)] = [scalar]
        return scalar

    async def get_scalar_values(
        self, node_id: int, property_id: int
    ) -> list[PropertyValueScalar]:
        return [
            v
            for v in self._values.get((node_id, property_id), [])
            if isinstance(v, PropertyValueScalar)
        ]

    async def remove_scalar_value(self, value_id: int) -> bool:
        found = False
        for key, values in list(self._values.items()):
            new_values = [v for v in values if getattr(v, "id", None) != value_id]
            if len(new_values) != len(values):
                found = True
            self._values[key] = new_values
        return found

    async def clear_scalar_values(self, node_id: int, property_id: int) -> int:
        key = (node_id, property_id)
        before = len(
            [v for v in self._values.get(key, []) if isinstance(v, PropertyValueScalar)]
        )
        self._values[key] = [
            v for v in self._values.get(key, []) if not isinstance(v, PropertyValueScalar)
        ]
        return before

    async def set_relation_value(
        self, node_id: int, property_id: int, target_id: int
    ) -> PropertyValueRelation:
        value = PropertyValueRelation(
            id=self._bump_value_id(),
            node_property_id=0,
            property_id=property_id,
            node_id=node_id,
            target_id=target_id,
        )
        self._values[(node_id, property_id)] = [value]
        return value

    async def get_relation_values(
        self, node_id: int, property_id: int
    ) -> list[PropertyValueRelation]:
        return [
            v
            for v in self._values.get((node_id, property_id), [])
            if isinstance(v, PropertyValueRelation)
        ]

    async def remove_relation_value(
        self, value_id: int, delete_target_node: bool = False
    ) -> bool:
        found = False
        for key, values in list(self._values.items()):
            new_values = [v for v in values if getattr(v, "id", None) != value_id]
            if len(new_values) != len(values):
                found = True
            self._values[key] = new_values
        return found

    async def clear_relation_values(
        self, node_id: int, property_id: int, delete_target_nodes: bool = False
    ) -> int:
        key = (node_id, property_id)
        before = len(
            [v for v in self._values.get(key, []) if isinstance(v, PropertyValueRelation)]
        )
        self._values[key] = [
            v
            for v in self._values.get(key, [])
            if not isinstance(v, PropertyValueRelation)
        ]
        return before

    async def delete_relation_values_by_target(self, target_id: int) -> int:
        count = 0
        for key, values in list(self._values.items()):
            new_values = [
                v
                for v in values
                if not (isinstance(v, PropertyValueRelation) and v.target_id == target_id)
            ]
            count += len(values) - len(new_values)
            self._values[key] = new_values
        return count

    async def add_selection_line(
        self,
        property_id: int,
        name: str,
        icon: str | None = None,
        sequence: int = 0,
    ) -> PropertySelectionLine:
        line = PropertySelectionLine(
            id=self._bump_id(),
            uuid=generate_uuid(),
            property_id=property_id,
            name=name,
            icon=icon,
            order=sequence,
        )
        self._selection_lines.setdefault(property_id, []).append(line)
        return line

    async def get_selection_lines(self, property_id: int) -> list[PropertySelectionLine]:
        return list(self._selection_lines.get(property_id, []))

    async def get_selection_line_by_uuid(self, uuid: str) -> PropertySelectionLine | None:
        for lines in self._selection_lines.values():
            for line in lines:
                if line.uuid == uuid:
                    return line
        return None

    async def get_selection_lines_by_ids(self, ids: list[int]) -> list[PropertySelectionLine]:
        result = []
        for lines in self._selection_lines.values():
            for line in lines:
                if line.id in ids:
                    result.append(line)
        return result

    async def get_selection_lines_by_uuids(self, uuids: list[str]) -> list[PropertySelectionLine]:
        result = []
        seen = set()
        for lines in self._selection_lines.values():
            for line in lines:
                if line.uuid in uuids and line.uuid not in seen:
                    result.append(line)
                    seen.add(line.uuid)
        return result

    async def update_selection_line(
        self,
        line_id: int,
        name: str | None = None,
        icon: str | None = None,
        order: int | None = None,
    ) -> PropertySelectionLine | None:
        for lines in self._selection_lines.values():
            for line in lines:
                if line.id == line_id:
                    if name is not None:
                        line.name = name
                    if icon is not None:
                        line.icon = icon
                    if order is not None:
                        line.order = order
                    return line
        return None

    async def can_delete_selection_line(self, line_id: int) -> tuple[bool, str]:
        return (True, "")

    async def delete_selection_line(self, line_id: int) -> bool:
        for prop_id, lines in list(self._selection_lines.items()):
            new_lines = [line for line in lines if line.id != line_id]
            if len(new_lines) != len(lines):
                self._selection_lines[prop_id] = new_lines
                return True
        return False

    async def set_selection_value(
        self, node_id: int, property_id: int, selection_line_id: int
    ) -> PropertyValueSelection:
        line_uuid = None
        for line in self._selection_lines.get(property_id, []):
            if line.id == selection_line_id:
                line_uuid = line.uuid
                break
        value = PropertyValueSelection(
            id=self._bump_value_id(),
            node_property_id=0,
            property_id=property_id,
            node_id=node_id,
            selection_line_id=selection_line_id,
            selection_line_uuid=line_uuid,
        )
        self._values[(node_id, property_id)] = [value]
        return value

    async def get_selection_values(
        self, node_id: int, property_id: int
    ) -> list[PropertyValueSelection]:
        return [
            v
            for v in self._values.get((node_id, property_id), [])
            if isinstance(v, PropertyValueSelection)
        ]

    async def remove_selection_value(self, value_id: int) -> bool:
        found = False
        for key, values in list(self._values.items()):
            new_values = [v for v in values if getattr(v, "id", None) != value_id]
            if len(new_values) != len(values):
                found = True
            self._values[key] = new_values
        return found

    async def clear_selection_values(self, node_id: int, property_id: int) -> int:
        key = (node_id, property_id)
        before = len(
            [v for v in self._values.get(key, []) if isinstance(v, PropertyValueSelection)]
        )
        self._values[key] = [
            v
            for v in self._values.get(key, [])
            if not isinstance(v, PropertyValueSelection)
        ]
        return before

    async def add_class_filter(
        self, property_id: int, class_node_id: int
    ) -> PropertyClassFilter:
        return PropertyClassFilter(
            id=self._bump_value_id(),
            uuid=generate_uuid(),
            class_node_id=class_node_id,
            property_id=property_id,
        )

    async def get_class_filters(self, property_id: int) -> list[PropertyClassFilter]:
        return []

    async def get_class_filter_by_uuid(self, uuid: str) -> PropertyClassFilter | None:
        return None

    async def remove_class_filter(
        self, property_id: int, class_node_id: int
    ) -> bool:
        return False

    async def get_all_property_values(
        self, node_id: int
    ) -> dict[int, dict[str, Any]]:
        result: dict[int, dict[str, Any]] = {}
        for (nid, prop_id), values in self._values.items():
            if nid != node_id:
                continue
            prop = self._properties.get(prop_id)
            if prop is None:
                continue
            result[prop_id] = {
                "property": prop,
                "node_property": NodeProperty(
                    node_id=node_id, property_id=prop_id, property_type=prop.type
                ),
                "values": values,
            }
        return result

    async def get_all_property_values_batch(
        self, node_ids: list[int]
    ) -> dict[int, dict[int, dict[str, Any]]]:
        return {node_id: await self.get_all_property_values(node_id) for node_id in node_ids}

    async def get_text_property_target_ids(self, target_ids: list[int]) -> set[int]:
        return set()

    async def clear_all_property_values(self, node_id: int, property_id: int) -> None:
        self._values.pop((node_id, property_id), None)

    async def get_class_properties(self, class_node_id: int) -> list[ClassProperty]:
        return []

    async def get_class_property_by_uuid(self, uuid: str) -> ClassProperty | None:
        return None

    async def add_class_property(
        self,
        class_node_id: int,
        property_id: int,
        sequence: int = 0,
        default_value: Any = None,
        required: bool | None = None,
        hidden: bool | None = None,
        readonly: bool | None = None,
        hide_when_empty: bool | None = None,
        prop_type: PropertyType | None = None,
    ) -> ClassProperty:
        return ClassProperty(
            id=self._bump_id(),
            uuid=generate_uuid(),
            class_node_id=class_node_id,
            property_id=property_id,
        )

    async def remove_class_property(
        self, class_node_id: int, property_id: int
    ) -> bool:
        return False

    async def update_class_property(
        self,
        class_node_id: int,
        property_id: int,
        *,
        clear_defaults: bool = False,
        default_columns: dict[str, Any] | None = None,
        **updates: Any,
    ) -> ClassProperty | None:
        return None

    async def get_all_inherited_properties(
        self, class_node_id: int
    ) -> list[ClassProperty]:
        return []

    async def get_class_property_edges_for_node(
        self, node_id: int, property_id: int
    ) -> list[ClassProperty]:
        return []

    async def get_property_stats(self) -> list[dict[str, Any]]:
        return []

    async def get_property_suggestions(self, node_id: int | None) -> list[dict[str, Any]]:
        return []


class FakeLinkParsingService:
    """No-op link-parsing service for unit tests that don't exercise backlinks."""

    async def update_node_links(self, node_id: int, content: str) -> None:
        return None

    async def update_inline_classes(self, node_id: int, content: str) -> None:
        return None

    async def get_backlinks(self, node_id: int) -> list[Any]:
        return []

    async def get_inline_class_references(self, node_id: int) -> list[Any]:
        return []

    async def get_alias_node_ids(self, target_node_id: int) -> list[int]:
        return []

    async def get_alias_node_ids_batch(
        self, target_node_ids: list[int]
    ) -> dict[int, list[int]]:
        return {nid: [] for nid in target_node_ids}

    async def get_text_links(self, node_id: int) -> list[Any]:
        return []

    async def get_text_links_batch(
        self, node_ids: list[int]
    ) -> dict[int, list[Any]]:
        return {nid: [] for nid in node_ids}

    async def get_inline_class_targets(self, node_id: int) -> list[int]:
        return []

    async def get_inline_classes_for_node(self, node_id: int) -> list[Any]:
        return []

    async def update_classes_path(self, node_id: int) -> None:
        return None

    async def get_alias_ids(self, target_node_id: int) -> list[int]:
        return []

    async def add_alias(self, target_node_id: int, alias_node_id: int) -> None:
        return None

    async def remove_alias(
        self, target_node_id: int, alias_node_id: int
    ) -> bool:
        return False

    async def get_links_for_nodes(
        self,
        node_ids: list[int],
        scope: str,
        cooccurrence: bool,
        context_node_id: int | None = None,
    ) -> list[dict[str, Any]]:
        return []

    async def rebuild_all_links(self) -> dict[str, Any]:
        return {}

    async def fix_raw_uuid_links(self) -> dict[str, Any]:
        return {}

    async def fix_links_for_uuid(self, target_uuid: str) -> dict[str, Any]:
        return {}

    async def get_property_backlinks(self, node_id: int) -> list[Any]:
        return []


class FakeClassExtendRepository:
    """In-memory class-extension repository that returns empty hierarchies."""

    async def get_extended_classes(self, class_node_id: int) -> list[int]:
        return []

    async def get_extended_classes_with_details(
        self, class_node_id: int
    ) -> list[Any]:
        return []

    async def add_extends(
        self,
        class_node_id: int,
        extends_class_id: int,
        sequence: int = 0,
    ) -> Any:
        raise NotImplementedError

    async def get_class_extend_by_uuid(self, uuid: str) -> ClassExtend | None:
        return None

    async def remove_extends(
        self, class_node_id: int, extends_class_id: int
    ) -> bool:
        return False

    async def get_classes_extended_by(
        self, class_node_id: int
    ) -> list[dict[str, Any]]:
        return []

    async def get_direct_subclasses(self, class_node_id: int) -> list[int]:
        return []

    async def get_extended_classes_batch(
        self, node_ids: list[int]
    ) -> dict[int, list[int]]:
        return {nid: [] for nid in node_ids}

    async def expand_class_hierarchy(self, class_ids: list[int]) -> set[int]:
        return set(class_ids)
