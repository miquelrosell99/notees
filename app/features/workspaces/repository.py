"""PostgreSQL implementation of WorkspaceRepository."""

from __future__ import annotations

import asyncio
import json
import shutil
import uuid
from datetime import UTC, datetime, timedelta
from typing import Any

import asyncpg

from app.config import settings
from app.db.connection import acquire_connection, get_workspace_dir
from app.domain.entities import generate_uuid
from app.domain.entities.constants import SYSTEM_CLASS_UUIDS, SYSTEM_PAGE_UUIDS
from app.domain.stringify_ast import (
    StringifyMode,
    StringifyOptions,
    parse_ast,
    stringify_ast,
)
from app.features.workspaces.port import WorkspaceIORepository, WorkspaceRepository
from app.logging_config import get_logger

logger = get_logger(__name__)

_BULK_DELETE_TIMEOUT = 600

# Legacy boolean node flags that map to system classes in the operation-log model.
_FLAG_TO_CLASS_KEY: dict[str, str] = {
    "is_task": "task",
    "is_template": "template",
    "is_day": "day",
    "is_month": "month",
    "is_year": "year",
    "is_asset": "asset",
    "is_table": "table",
    "is_card": "card",
    "is_cloze": "cloze",
    "is_comment": "comment",
}


def _name_ast(text: str) -> list[dict[str, Any]]:
    """Return a minimal paragraph AST for a plain-text node name."""
    return [
        {
            "type": "paragraph",
            "children": [{"type": "text", "text": text}],
        }
    ]


def _extract_plain_text(content_json_or_name: Any) -> str:
    """Extract plain text from a derived content AST or a legacy name string."""
    if content_json_or_name is None:
        return "untitled"
    value = content_json_or_name
    if isinstance(value, (list, dict)):
        try:
            ast = value if isinstance(value, list) else [value]
            opts = StringifyOptions(mode=StringifyMode.TEXT_ONLY)
            return stringify_ast(ast, opts) or "untitled"
        except (ValueError, TypeError):
            return "untitled"
    if isinstance(value, str):
        try:
            ast = parse_ast(value)
            opts = StringifyOptions(mode=StringifyMode.TEXT_ONLY)
            return stringify_ast(ast, opts) or value.strip() or "untitled"
        except (ValueError, TypeError):
            return value.strip() or "untitled"
    return "untitled"


def _node_kind_from_flags(
    is_class: bool,
    is_page: bool,
    is_day: bool = False,
    is_month: bool = False,
    is_year: bool = False,
    is_template: bool = False,
) -> str:
    """Derive the operation-log node kind from legacy boolean flags."""
    if is_class:
        return "class"
    if is_page or is_day or is_month or is_year or is_template:
        return "page"
    return "block"


def _is_valid_uuid(value: Any) -> bool:
    """Return True if ``value`` is a valid UUID string."""
    if not isinstance(value, str):
        return False
    try:
        uuid.UUID(value)
    except ValueError:
        return False
    return True


def _build_uuid_map(dump_data: dict, remap_uuids: bool) -> dict[str, str]:
    """Build a map of old UUIDs to new UUIDs when remapping is enabled."""
    uuid_map: dict[str, str] = {}
    if not remap_uuids:
        return uuid_map

    entity_keys = [
        "nodes",
        "links",
        "properties",
        "property_selection_lines",
        "node_properties",
        "property_value_scalars",
        "property_value_relations",
        "property_value_selections",
        "node_views",
    ]
    for key in entity_keys:
        for item in dump_data.get(key, []):
            old_uuid = item.get("uuid")
            if old_uuid and _is_valid_uuid(old_uuid):
                uuid_map[str(old_uuid).lower()] = generate_uuid()

    ws_uuid = dump_data.get("workspace", {}).get("uuid")
    if ws_uuid and _is_valid_uuid(ws_uuid):
        uuid_map[str(ws_uuid).lower()] = generate_uuid()

    return uuid_map


def _resolve_id(old_id: Any, uuid_map: dict[str, str], remap_uuids: bool) -> str:
    """Resolve a single dump id to a UUID string."""
    if old_id is None:
        return generate_uuid()
    if isinstance(old_id, str):
        lower = old_id.lower()
        if _is_valid_uuid(old_id):
            if remap_uuids:
                return uuid_map.get(lower, generate_uuid())
            return old_id
        try:
            int(old_id)
            return generate_uuid()
        except ValueError:
            return generate_uuid()
    return generate_uuid()


def _ensure_mapped(
    old_id: Any,
    id_map: dict[Any, str],
    uuid_map: dict[str, str],
    remap_uuids: bool,
) -> str:
    """Return the mapped UUID for ``old_id``, creating it if necessary."""
    if old_id in id_map:
        return id_map[old_id]
    new_id = _resolve_id(old_id, uuid_map, remap_uuids)
    id_map[old_id] = new_id
    return new_id


def _build_import_operation(
    workspace_uuid: str,
    actor_id: str,
    op_type: str,
    payload: dict[str, Any],
    affected_node_ids: list[str] | None = None,
    physical_time: int | None = None,
    logical_counter: list[int] | None = None,
):
    """Build an Operation with a monotonically increasing HLC."""
    from app.core.clock import Hlc
    from app.core.operation import create_operation

    if physical_time is None:
        physical_time = int(datetime.now(UTC).timestamp() * 1000)
    if logical_counter is None:
        logical_counter = [0]
    hlc = Hlc(physical=physical_time, logical=logical_counter[0])
    logical_counter[0] += 1
    return create_operation(
        envelope={
            "workspace_id": workspace_uuid,
            "actor_id": actor_id,
            "hlc": hlc,
            "affected_node_ids": affected_node_ids or [],
            "op_type": op_type,
        },
        payload=payload,
    )


class PostgresWorkspaceRepository(WorkspaceRepository):
    """PostgreSQL adapter for workspace lifecycle, membership, and invite operations."""

    def __init__(self, pool: asyncpg.Pool):
        self._pool = pool
        self._relay_storage: Any | None = None

    def _relay(self):
        from app.relay.dependencies import get_relay_storage

        if self._relay_storage is None:
            self._relay_storage = get_relay_storage()
        return self._relay_storage

    async def _workspace_uuid(self, workspace_id: int) -> str | None:
        async with acquire_connection(self._pool) as conn:
            row = await conn.fetchrow(
                "SELECT uuid::text as uuid FROM workspace WHERE id = $1",
                workspace_id,
            )
            return row["uuid"] if row else None

    async def _user_row(self, user_id: int) -> asyncpg.Record | None:
        async with acquire_connection(self._pool) as conn:
            return await conn.fetchrow(
                'SELECT uuid::text as uuid, email, name FROM "user" WHERE id = $1',
                user_id,
            )

    def _store(self, workspace_uuid: str, actor_id: str):
        from app.core.workspace_store import WorkspaceStore

        return WorkspaceStore(
            workspace_id=workspace_uuid,
            actor_id=actor_id,
            relay_storage=self._relay(),
        )

    # -------------------------------------------------------------------------
    # Lifecycle CRUD
    # -------------------------------------------------------------------------

    async def list_workspaces(self, user_id: int) -> list[Any]:
        async with acquire_connection(self._pool) as conn:
            return await conn.fetch(
                """
                SELECT DISTINCT g.id, g.uuid, g.name, g.create_date, g.write_date, g.is_shared,
                                g.sync_protocol_version,
                                g.create_uid = $1 as is_owner,
                                gs.can_read as s_can_read,
                                gs.can_write as s_can_write,
                                gs.can_create as s_can_create,
                                gs.can_delete as s_can_delete
                FROM workspace g
                LEFT JOIN workspace_share gs
                    ON g.id = gs.workspace_id
                    AND gs.user_id = $1
                    AND gs.active = TRUE
                WHERE g.create_uid = $1 OR gs.user_id = $1
                ORDER BY g.create_date DESC
                """,
                user_id,
            )

    async def get_by_name_and_owner(self, name: str, owner_id: int) -> Any | None:
        async with acquire_connection(self._pool) as conn:
            return await conn.fetchrow(
                """
                SELECT id, uuid, name, create_date
                FROM workspace
                WHERE create_uid = $1 AND name = $2 AND active = TRUE
                """,
                owner_id,
                name,
            )

    async def create(self, name: str, owner_id: int) -> Any:
        async with acquire_connection(self._pool) as conn:
            return await conn.fetchrow(
                """
                INSERT INTO workspace (name, create_uid, write_uid, is_shared, active)
                VALUES ($1, $2, $2, FALSE, TRUE)
                RETURNING id, uuid, name, create_date
                """,
                name,
                owner_id,
            )

    async def get_by_uuid_for_user(self, workspace_uuid: str, user_id: int) -> Any | None:
        async with acquire_connection(self._pool) as conn:
            return await conn.fetchrow(
                """
                SELECT g.id FROM workspace g
                LEFT JOIN workspace_share gs ON g.id = gs.workspace_id
                WHERE g.uuid::text = $1 AND g.active = TRUE
                  AND (g.create_uid = $2 OR gs.user_id = $2)
                """,
                workspace_uuid,
                user_id,
            )

    async def get_id_by_uuid_and_owner(self, workspace_uuid: str, owner_id: int) -> int | None:
        async with acquire_connection(self._pool) as conn:
            row = await conn.fetchrow(
                "SELECT id FROM workspace WHERE create_uid = $1 AND uuid::text = $2",
                owner_id,
                workspace_uuid,
            )
            return row["id"] if row else None

    async def rename(self, workspace_id: int, new_name: str, owner_id: int) -> Any | None:
        async with acquire_connection(self._pool) as conn:
            return await conn.fetchrow(
                """
                UPDATE workspace
                SET name = $1, write_date = NOW(), write_uid = $3
                WHERE id = $2
                RETURNING uuid, name, create_date
                """,
                new_name,
                workspace_id,
                owner_id,
            )

    async def delete_cascade(self, workspace_id: int) -> bool:
        async with acquire_connection(self._pool) as conn:
            ws_row = await conn.fetchrow(
                "SELECT id, uuid::text as uuid FROM workspace WHERE id = $1",
                workspace_id,
                timeout=_BULK_DELETE_TIMEOUT,
            )
            if not ws_row:
                return False

            workspace_uuid = ws_row["uuid"]

            result = await conn.execute(
                "DELETE FROM workspace WHERE id = $1",
                workspace_id,
                timeout=_BULK_DELETE_TIMEOUT,
            )
            deleted = result.split()[-1] != "0"

        if not deleted:
            return False

        relay = self._relay()
        max_hlc = await relay.get_max_hlc(workspace_uuid)
        if max_hlc.physical > 0 or max_hlc.logical > 0:
            await relay.prune_envelopes(workspace_uuid, max_hlc)

        async with acquire_connection(self._pool) as conn:
            await conn.execute(
                "DELETE FROM relay_snapshot WHERE workspace_id = $1",
                workspace_uuid,
            )
            await conn.execute(
                "DELETE FROM compacted_operation_segment WHERE workspace_id = $1",
                workspace_uuid,
            )

        derived_db_path = settings.database_dir / "relay" / "derived" / f"{workspace_uuid}.db"
        if derived_db_path.exists():
            try:
                derived_db_path.unlink()
            except Exception as e:
                logger.error(f"Failed to delete derived DB {derived_db_path}: {e}", exc_info=True)

        workspace_dir_path = get_workspace_dir(workspace_uuid)
        if workspace_dir_path.exists():
            try:
                shutil.rmtree(workspace_dir_path)
                logger.info(f"Deleted workspace folder: {workspace_dir_path}")
            except Exception as e:
                logger.error(
                    f"Failed to delete workspace folder {workspace_dir_path}: {e}",
                    exc_info=True,
                )

        return True

    async def resolve_workspace_for_export(
        self, user_id: int, workspace_uuid: str | None = None
    ) -> int:
        from ...db.schema.init import get_or_create_user_workspace

        async with acquire_connection(self._pool) as conn:
            return await get_or_create_user_workspace(conn, user_id, workspace_uuid=workspace_uuid)

    async def seed_workspace(self, workspace_id: int, user_id: int) -> None:
        workspace_uuid = await self._workspace_uuid(workspace_id)
        if not workspace_uuid:
            raise ValueError(f"Workspace {workspace_id} not found")
        user = await self._user_row(user_id)
        if not user:
            raise ValueError(f"User {user_id} not found")

        actor_id = user["uuid"]
        store = self._store(workspace_uuid, actor_id)
        try:
            class_class_id = SYSTEM_CLASS_UUIDS["class"]
            page_class_id = SYSTEM_CLASS_UUIDS["page"]

            for class_name, class_uuid in SYSTEM_CLASS_UUIDS.items():
                await store.create_class(class_uuid, class_name)
                await store.update_content(class_uuid, _name_ast(class_name))
                await store.assign_class(class_uuid, class_class_id)
                await store.assign_class(class_uuid, page_class_id)

            for page_name, page_uuid in SYSTEM_PAGE_UUIDS.items():
                await store.create_node(
                    page_uuid,
                    "page",
                    class_ids=[page_class_id],
                    initial_content=_name_ast(page_name.capitalize()),
                )
        finally:
            await store.close()

    async def ensure_user_page(self, workspace_id: int, user_id: int) -> str | None:
        workspace_uuid = await self._workspace_uuid(workspace_id)
        if not workspace_uuid:
            return None
        user = await self._user_row(user_id)
        if not user:
            return None

        user_uuid = user["uuid"]
        display = user["name"] or user["email"] or "User"
        user_page_uuid = str(
            uuid.uuid5(
                uuid.NAMESPACE_OID,
                f"notees:user-page:{workspace_uuid}:{user_uuid}",
            )
        )

        store = self._store(workspace_uuid, user_uuid)
        try:
            existing = await store.query(
                "SELECT 1 FROM node WHERE id = ?",
                (user_page_uuid,),
            )
            if not existing:
                await store.create_node(
                    user_page_uuid,
                    "page",
                    class_ids=[SYSTEM_CLASS_UUIDS["page"]],
                    initial_content=_name_ast(display),
                )
            return user_page_uuid
        finally:
            await store.close()

    # -------------------------------------------------------------------------
    # Membership / invite helpers
    # -------------------------------------------------------------------------

    async def get_workspace_uuid_by_name_for_user(self, name: str, user_id: int) -> str | None:
        async with acquire_connection(self._pool) as conn:
            row = await conn.fetchrow(
                """
                SELECT g.uuid::text as uuid
                FROM workspace g
                LEFT JOIN workspace_share gs ON g.id = gs.workspace_id
                WHERE g.name = $2 AND g.active = TRUE
                  AND (g.create_uid = $1 OR gs.user_id = $1)
                """,
                user_id,
                name,
            )
            return row["uuid"] if row else None

    async def get_workspace_id_owner(self, workspace_uuid: str) -> tuple[int, int] | None:
        async with acquire_connection(self._pool) as conn:
            row = await conn.fetchrow(
                """
                SELECT id, create_uid
                FROM workspace
                WHERE uuid::text = $1 AND active = TRUE
                """,
                workspace_uuid,
            )
            if not row:
                return None
            return row["id"], row["create_uid"]

    async def get_sync_protocol_version(self, workspace_id: int) -> str:
        async with acquire_connection(self._pool) as conn:
            row = await conn.fetchrow(
                "SELECT sync_protocol_version FROM workspace WHERE id = $1",
                workspace_id,
            )
            return row["sync_protocol_version"] if row else "v2"

    async def set_sync_protocol_version(self, workspace_id: int, version: str) -> None:
        async with acquire_connection(self._pool) as conn:
            await conn.execute(
                """
                UPDATE workspace
                SET sync_protocol_version = $1, write_date = NOW()
                WHERE id = $2
                """,
                version,
                workspace_id,
            )

    async def is_workspace_member(self, workspace_id: int, user_id: int) -> bool:
        async with acquire_connection(self._pool) as conn:
            row = await conn.fetchrow(
                """
                SELECT 1 FROM workspace_share
                WHERE workspace_id = $1 AND user_id = $2 AND active = TRUE
                """,
                workspace_id,
                user_id,
            )
            return row is not None

    async def invite_existing_member(
        self, workspace_id: int, target_id: int, role: str, owner_id: int
    ) -> None:
        perms = _role_to_perms(role)
        async with acquire_connection(self._pool) as conn:
            await conn.execute(
                """
                INSERT INTO workspace_share (
                    workspace_id, user_id, can_read, can_write, can_create, can_delete, can_comment,
                    active, create_uid, write_uid
                )
                VALUES ($1, $2, $3, $4, $5, $6, $7, TRUE, $8, $8)
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
                workspace_id,
                target_id,
                perms["can_read"],
                perms["can_write"],
                perms["can_create"],
                perms["can_delete"],
                perms["can_comment"],
                owner_id,
            )
            await conn.execute(
                "UPDATE workspace SET is_shared = TRUE WHERE id = $1",
                workspace_id,
            )

    async def create_pending_invite(
        self, workspace_id: int, email: str, role: str, invited_by: int
    ) -> str:
        invite_uuid = str(uuid.uuid4())
        expires_at = datetime.now(UTC) + timedelta(days=7)
        async with acquire_connection(self._pool) as conn:
            await conn.execute(
                """
                INSERT INTO pending_invite (uuid, email, workspace_id, role, invited_by, expires_at, active)
                VALUES ($1, $2, $3, $4, $5, $6, TRUE)
                ON CONFLICT (email, workspace_id, node_id)
                DO UPDATE SET
                    role = EXCLUDED.role,
                    invited_by = EXCLUDED.invited_by,
                    expires_at = EXCLUDED.expires_at,
                    active = TRUE,
                    created_at = NOW()
                """,
                invite_uuid,
                email,
                workspace_id,
                role,
                invited_by,
                expires_at,
            )
        return invite_uuid

    async def list_members(
        self, workspace_id: int, page: int, page_size: int
    ) -> dict[str, Any]:
        async with acquire_connection(self._pool) as conn:
            owner_row = await conn.fetchrow(
                """
                SELECT u.id, u.email, u.uuid as user_uuid
                FROM workspace g
                JOIN "user" u ON u.id = g.create_uid
                WHERE g.id = $1
                """,
                workspace_id,
            )

            offset = (page - 1) * page_size
            if offset == 0:
                share_limit = max(0, page_size - 1) if owner_row else page_size
                share_offset = 0
            else:
                share_limit = page_size
                share_offset = max(0, offset - 1) if owner_row else offset

            rows = await conn.fetch(
                """
                SELECT u.id, u.email, u.uuid as user_uuid,
                       gs.uuid as share_uuid,
                       gs.can_read, gs.can_write, gs.can_create, gs.can_delete, gs.can_comment,
                       gs.create_date
                FROM workspace_share gs
                JOIN "user" u ON u.id = gs.user_id
                WHERE gs.workspace_id = $1 AND gs.active = TRUE
                ORDER BY gs.create_date DESC
                LIMIT $2 OFFSET $3
                """,
                workspace_id,
                share_limit,
                share_offset,
            )

            pending_rows = []
            if offset == 0:
                pending_rows = await conn.fetch(
                    """
                    SELECT uuid as invite_uuid, email, role, created_at
                    FROM pending_invite
                    WHERE workspace_id = $1 AND node_id IS NULL AND active = TRUE
                      AND (expires_at IS NULL OR expires_at > NOW())
                    ORDER BY created_at DESC
                    """,
                    workspace_id,
                )

        return {
            "owner": owner_row,
            "members": rows,
            "pending": pending_rows,
            "offset": offset,
        }

    async def update_member_role(
        self, workspace_id: int, member_user_id: int, role: str, owner_id: int
    ) -> bool:
        perms = _role_to_perms(role)
        async with acquire_connection(self._pool) as conn:
            result = await conn.execute(
                """
                UPDATE workspace_share
                SET can_read = $1, can_write = $2, can_create = $3, can_delete = $4, can_comment = $5,
                    write_uid = $6, write_date = NOW()
                WHERE workspace_id = $7 AND user_id = $8 AND active = TRUE
                """,
                perms["can_read"],
                perms["can_write"],
                perms["can_create"],
                perms["can_delete"],
                perms["can_comment"],
                owner_id,
                workspace_id,
                member_user_id,
            )
            return result.split()[-1] != "0"

    async def remove_member(self, workspace_id: int, member_user_id: int) -> None:
        async with acquire_connection(self._pool) as conn:
            await conn.execute(
                """
                UPDATE workspace_share
                SET active = FALSE
                WHERE workspace_id = $1 AND user_id = $2
                """,
                workspace_id,
                member_user_id,
            )

    async def remove_pending_invite(self, workspace_id: int, email: str) -> None:
        async with acquire_connection(self._pool) as conn:
            await conn.execute(
                """
                UPDATE pending_invite
                SET active = FALSE
                WHERE workspace_id = $1 AND email = $2 AND node_id IS NULL
                """,
                workspace_id,
                email,
            )

    async def mark_workspace_shared(self, workspace_id: int) -> None:
        async with acquire_connection(self._pool) as conn:
            await conn.execute(
                "UPDATE workspace SET is_shared = TRUE WHERE id = $1",
                workspace_id,
            )


def _role_to_perms(role: str) -> dict[str, bool]:
    defaults = {
        "viewer": {"can_read": True, "can_write": False, "can_create": False, "can_delete": False, "can_comment": False},
        "commenter": {"can_read": True, "can_write": False, "can_create": False, "can_delete": False, "can_comment": True},
        "editor": {"can_read": True, "can_write": True, "can_create": True, "can_delete": False, "can_comment": True},
        "admin": {"can_read": True, "can_write": True, "can_create": True, "can_delete": True, "can_comment": True},
    }
    return defaults.get(role, defaults["viewer"])


class PostgresWorkspaceIORepository(WorkspaceIORepository):
    """PostgreSQL adapter for workspace import/export and restore."""

    def __init__(self, pool: asyncpg.Pool):
        self._pool = pool
        self._relay_storage: Any | None = None

    def _relay(self):
        from app.relay.dependencies import get_relay_storage

        if self._relay_storage is None:
            self._relay_storage = get_relay_storage()
        return self._relay_storage

    async def _workspace_uuid(self, workspace_id: int) -> str | None:
        async with acquire_connection(self._pool) as conn:
            row = await conn.fetchrow(
                "SELECT uuid::text as uuid FROM workspace WHERE id = $1",
                workspace_id,
            )
            return row["uuid"] if row else None

    async def _user_uuid(self, user_id: int) -> str | None:
        async with acquire_connection(self._pool) as conn:
            row = await conn.fetchrow(
                'SELECT uuid::text as uuid FROM "user" WHERE id = $1',
                user_id,
            )
            return row["uuid"] if row else None

    def _store(self, workspace_uuid: str, actor_id: str):
        from app.core.workspace_store import WorkspaceStore

        return WorkspaceStore(
            workspace_id=workspace_uuid,
            actor_id=actor_id,
            relay_storage=self._relay(),
        )

    async def export_workspace_full(self, workspace_id: int) -> dict:
        """Create a comprehensive dump of all workspace data from derived SQLite."""
        workspace_uuid = await self._workspace_uuid(workspace_id)
        if not workspace_uuid:
            raise ValueError(f"Workspace {workspace_id} not found")

        async with acquire_connection(self._pool) as conn:
            workspace_row = await conn.fetchrow(
                "SELECT uuid::text as uuid, name FROM workspace WHERE id = $1",
                workspace_id,
            )
        if not workspace_row:
            raise ValueError(f"Workspace {workspace_id} not found")

        actor_id = str(workspace_row["uuid"])
        store = self._store(workspace_uuid, actor_id)
        try:
            await store.sync()

            node_rows = await store.query(
                "SELECT id, kind, class_ids, parent_id, content, created_at, updated_at FROM node WHERE workspace_id = ?",
                (workspace_uuid,),
            )
            nodes = []
            for row in node_rows:
                class_ids = _load_json(row["class_ids"], [])
                content = _load_json(row["content"], [])
                name = _extract_plain_text(content)
                kind = row["kind"]
                nodes.append(
                    {
                        "id": row["id"],
                        "uuid": row["id"],
                        "name": name,
                        "kind": kind,
                        "is_class": kind == "class",
                        "is_page": kind == "page",
                        "is_day": SYSTEM_CLASS_UUIDS["day"] in class_ids,
                        "is_month": SYSTEM_CLASS_UUIDS["month"] in class_ids,
                        "is_year": SYSTEM_CLASS_UUIDS["year"] in class_ids,
                        "is_asset": SYSTEM_CLASS_UUIDS["asset"] in class_ids,
                        "is_template": SYSTEM_CLASS_UUIDS["template"] in class_ids,
                        "is_comment": SYSTEM_CLASS_UUIDS["comment"] in class_ids,
                        "is_task": SYSTEM_CLASS_UUIDS["task"] in class_ids,
                        "is_table": SYSTEM_CLASS_UUIDS["table"] in class_ids,
                        "is_card": SYSTEM_CLASS_UUIDS["card"] in class_ids,
                        "is_cloze": SYSTEM_CLASS_UUIDS["cloze"] in class_ids,
                        "parent_id": row["parent_id"],
                        "class_ids": class_ids,
                        "active": True,
                        "create_date": row["created_at"],
                        "write_date": row["updated_at"],
                    }
                )

            node_link_rows = await store.query(
                "SELECT id, source_id, target_id, type, label, click_count, last_navigated_at, created_at, updated_at FROM node_link WHERE workspace_id = ?",
                (workspace_uuid,),
            )
            links = []
            for row in node_link_rows:
                links.append(
                    {
                        "id": row["id"],
                        "uuid": row["id"],
                        "source_id": row["source_id"],
                        "target_id": row["target_id"],
                        "type": row["type"],
                        "label": row["label"],
                        "click_count": row["click_count"],
                        "last_navigated_at": row["last_navigated_at"],
                        "create_date": row["created_at"],
                        "write_date": row["updated_at"],
                    }
                )

            property_rows = await store.query(
                "SELECT id, name, icon, type, multi, is_system, scope, node_id, icon_visibility, options, active, created_at, updated_at FROM property_schema WHERE workspace_id = ?",
                (workspace_uuid,),
            )
            properties = []
            selection_lines = []
            for row in property_rows:
                options = _load_json(row["options"], [])
                for opt in options:
                    opt_id = opt.get("id")
                    if not opt_id and isinstance(opt, dict):
                        opt_id = generate_uuid()
                    if opt_id:
                        selection_lines.append(
                            {
                                "id": opt_id,
                                "uuid": opt_id,
                                "property_id": row["id"],
                                "name": opt.get("name", ""),
                                "icon": opt.get("icon"),
                                "create_date": row["created_at"],
                                "write_date": row["updated_at"],
                            }
                        )
                properties.append(
                    {
                        "id": row["id"],
                        "uuid": row["id"],
                        "name": row["name"],
                        "icon": row["icon"],
                        "type": row["type"],
                        "is_multi": bool(row["multi"]),
                        "is_system": bool(row["is_system"]),
                        "scope": row["scope"],
                        "node_id": row["node_id"],
                        "icon_visibility": row["icon_visibility"],
                        "active": bool(row["active"]),
                        "create_date": row["created_at"],
                        "write_date": row["updated_at"],
                    }
                )

            value_rows = await store.query(
                """
                SELECT pv.id, pv.node_id, pv.property_schema_id, pv.value, pv.idx
                FROM property_value pv
                JOIN property_schema ps ON ps.id = pv.property_schema_id
                WHERE ps.workspace_id = ?
                """,
                (workspace_uuid,),
            )
            value_scalars = []
            value_relations = []
            value_selections = []
            for row in value_rows:
                raw_value = _load_json(row["value"], None)
                prop_type = next(
                    (p["type"] for p in properties if p["id"] == row["property_schema_id"]),
                    "text",
                )
                base = {
                    "id": row["id"],
                    "uuid": row["id"],
                    "node_id": row["node_id"],
                    "property_id": row["property_schema_id"],
                    "node_property_id": row["id"],
                }
                if prop_type in ("node", "relation"):
                    value_relations.append({**base, "target_id": raw_value, "order": row["idx"]})
                elif prop_type == "selection":
                    value_selections.append({**base, "selection_line_id": raw_value})
                else:
                    value_scalars.append(
                        {
                            **base,
                            "value_text": raw_value if prop_type not in ("boolean", "integer", "float") else None,
                            "value_boolean": raw_value if prop_type == "boolean" else None,
                            "value_integer": raw_value if prop_type == "integer" else None,
                            "value_float": raw_value if prop_type == "float" else None,
                        }
                    )

            class_property_rows = await store.query(
                """
                SELECT class_id, property_schema_id, sequence, default_value, hidden
                FROM class_property_edge
                WHERE class_id IN (SELECT id FROM node WHERE workspace_id = ?)
                """,
                (workspace_uuid,),
            )
            class_properties = []
            for row in class_property_rows:
                class_properties.append(
                    {
                        "class_node_id": row["class_id"],
                        "property_id": row["property_schema_id"],
                        "sequence": row["sequence"],
                        "hidden": bool(row["hidden"]),
                        "default_value": row["default_value"],
                    }
                )

            class_extend_rows = await store.query(
                """
                SELECT ch.class_id, ch.ancestor_id
                FROM class_hierarchy ch
                JOIN node n ON n.id = ch.class_id
                WHERE n.workspace_id = ? AND ch.class_id != ch.ancestor_id
                """,
                (workspace_uuid,),
            )
            class_extends = []
            for row in class_extend_rows:
                class_extends.append(
                    {
                        "target_id": row["class_id"],
                        "source_id": row["ancestor_id"],
                    }
                )

            view_rows = await store.query(
                "SELECT id, node_id, name, view_type, order_index, is_default, active, shown_properties, group_by, view_mode, sort_entries, settings, query_ast, created_at, updated_at FROM node_view WHERE workspace_id = ?",
                (workspace_uuid,),
            )
            node_views = []
            for row in view_rows:
                node_views.append(
                    {
                        "id": row["id"],
                        "uuid": row["id"],
                        "node_id": row["node_id"],
                        "name": row["name"],
                        "query_json": _load_json(row["query_ast"], {}),
                        "view_type": row["view_type"],
                        "order_index": row["order_index"],
                        "is_default": bool(row["is_default"]),
                        "active": bool(row["active"]),
                        "shown_properties": _load_json(row["shown_properties"], []),
                        "group_by": _load_json(row["group_by"], None),
                        "view_mode": row["view_mode"],
                        "sort_entries": _load_json(row["sort_entries"], []),
                        "settings": _load_json(row["settings"], {}),
                        "create_date": row["created_at"],
                        "write_date": row["updated_at"],
                    }
                )

            async with acquire_connection(self._pool) as conn:
                settings_rows = await conn.fetch(
                    "SELECT key, value FROM setting_workspace WHERE workspace_id = $1",
                    workspace_id,
                )

            return {
                "version": 3,
                "workspace": {
                    "uuid": str(workspace_row["uuid"]),
                    "name": workspace_row["name"],
                },
                "nodes": nodes,
                "links": links,
                "properties": properties,
                "property_selection_lines": selection_lines,
                "node_properties": [],
                "property_value_scalars": value_scalars,
                "property_value_relations": value_relations,
                "property_value_selections": value_selections,
                "class_properties": class_properties,
                "class_extends": class_extends,
                "property_class_filters": [],
                "node_views": node_views,
                "settings": [dict(r) for r in settings_rows],
            }
        finally:
            await store.close()

    async def create_workspace_for_import(self, name: str, owner_id: int) -> dict:
        """Insert a workspace for import and return the inserted row."""
        async with acquire_connection(self._pool) as conn, conn.transaction():
            existing = await conn.fetchrow(
                "SELECT id FROM workspace WHERE create_uid = $1 AND name = $2 AND active = TRUE",
                owner_id,
                name,
            )
            if existing:
                raise ValueError(f"Workspace '{name}' already exists")

            row = await conn.fetchrow(
                """
                INSERT INTO workspace (name, create_uid, write_uid, is_shared, active)
                VALUES ($1, $2, $2, FALSE, TRUE)
                RETURNING id, uuid, name, create_date
                """,
                name,
                owner_id,
            )
            if row is None:
                raise RuntimeError("Failed to create workspace")
            return dict(row)

    async def get_workspace_by_name_for_user(self, name: str, user_id: int) -> dict | None:
        """Get workspace row with id/uuid/name by name for a user."""
        async with acquire_connection(self._pool) as conn:
            row = await conn.fetchrow(
                """
                SELECT g.id, g.uuid::text as uuid, g.name
                FROM workspace g
                LEFT JOIN workspace_share gs ON g.id = gs.workspace_id
                WHERE g.name = $2 AND g.active = TRUE
                  AND (g.create_uid = $1 OR gs.user_id = $1)
                """,
                user_id,
                name,
            )
            return dict(row) if row else None

    async def get_workspace_by_uuid_for_user(self, uuid: str, user_id: int) -> dict | None:
        """Get workspace row with id/uuid/name by uuid for a user."""
        async with acquire_connection(self._pool) as conn:
            row = await conn.fetchrow(
                """
                SELECT g.id, g.uuid::text as uuid, g.name
                FROM workspace g
                LEFT JOIN workspace_share gs ON g.id = gs.workspace_id
                WHERE g.uuid::text = $2 AND g.active = TRUE
                  AND (g.create_uid = $1 OR gs.user_id = $1)
                """,
                user_id,
                uuid,
            )
            return dict(row) if row else None

    async def import_dump(
        self,
        workspace_id: int,
        user_id: int,
        dump_data: dict,
        remap_uuids: bool,
        cleanup_invalid_cloze: bool = False,
    ) -> tuple[dict, dict[str, str]]:
        """Translate a legacy dump into operations and apply them to the relay."""
        workspace_uuid = await self._workspace_uuid(workspace_id)
        if not workspace_uuid:
            raise ValueError(f"Workspace {workspace_id} not found")
        actor_id = await self._user_uuid(user_id)
        if not actor_id:
            raise ValueError(f"User {user_id} not found")

        uuid_map = _build_uuid_map(dump_data, remap_uuids)
        node_id_map: dict[Any, str] = {}
        property_id_map: dict[Any, str] = {}
        selection_line_id_map: dict[Any, str] = {}

        operations = self._build_import_operations(
            workspace_uuid,
            actor_id,
            dump_data,
            uuid_map,
            node_id_map,
            property_id_map,
            selection_line_id_map,
        )

        store = self._store(workspace_uuid, actor_id)
        try:
            await store.apply_many(operations)
            stats = {
                "nodes": len(node_id_map),
                "properties": len(property_id_map),
                "property_selection_lines": len(selection_line_id_map),
                "operations": len(operations),
            }

            if cleanup_invalid_cloze:
                cleaned = await self._cleanup_invalid_cloze(store)
                stats["invalid_cloze_cleaned"] = cleaned

            return stats, uuid_map
        finally:
            await store.close()

    def _build_import_operations(
        self,
        workspace_uuid: str,
        actor_id: str,
        dump_data: dict,
        uuid_map: dict[str, str],
        node_id_map: dict[Any, str],
        property_id_map: dict[Any, str],
        selection_line_id_map: dict[Any, str],
    ) -> list[Any]:
        """Convert a legacy dump into operation-log operations."""
        from app.core.operation import Operation
        from app.core.uuid import uuidv7

        physical_time = int(datetime.now(UTC).timestamp() * 1000)
        logical_counter = [0]
        operations: list[Operation] = []

        def _op(
            op_type: str,
            payload: dict[str, Any],
            affected_node_ids: list[str] | None = None,
        ) -> Operation:
            return _build_import_operation(
                workspace_uuid,
                actor_id,
                op_type,
                payload,
                affected_node_ids,
                physical_time,
                logical_counter,
            )

        remap_uuids = bool(uuid_map)

        def _map_node_id(old_id: Any) -> str | None:
            if old_id is None:
                return None
            return _ensure_mapped(old_id, node_id_map, uuid_map, remap_uuids)

        def _map_property_id(old_id: Any) -> str | None:
            if old_id is None:
                return None
            return _ensure_mapped(old_id, property_id_map, uuid_map, remap_uuids)

        def _map_selection_line_id(old_id: Any) -> str | None:
            if old_id is None:
                return None
            return _ensure_mapped(old_id, selection_line_id_map, uuid_map, remap_uuids)

        # Phase 1: property schemas (with selection-line options).
        selection_lines_by_property: dict[str, list[dict[str, Any]]] = {}
        for sl in dump_data.get("property_selection_lines", []):
            prop_old_id = sl.get("property_id")
            prop_uuid = _map_property_id(prop_old_id)
            if prop_uuid is None:
                continue
            line_uuid = _map_selection_line_id(sl.get("id"))
            selection_lines_by_property.setdefault(prop_uuid, []).append(
                {
                    "id": line_uuid,
                    "name": sl.get("name", ""),
                    "icon": sl.get("icon"),
                }
            )

        property_type_map: dict[str, str] = {}
        for prop in dump_data.get("properties", []):
            prop_uuid = _map_property_id(prop.get("id"))
            if prop_uuid is None:
                continue
            property_type_map[prop_uuid] = prop.get("type", "text")
            scope = prop.get("scope", "global")
            node_old_id = prop.get("node_id")
            node_uuid = _map_node_id(node_old_id) if scope == "node" else None
            operations.append(
                _op(
                    "propertySchema.create",
                    {
                        "schemaId": prop_uuid,
                        "name": prop.get("name", ""),
                        "icon": prop.get("icon"),
                        "type": prop.get("type", "text"),
                        "multi": bool(prop.get("is_multi", False)),
                        "isSystem": bool(prop.get("is_system", False)),
                        "scope": scope,
                        "nodeId": node_uuid,
                        "iconVisibility": prop.get("icon_visibility"),
                        "options": selection_lines_by_property.get(prop_uuid, []),
                    },
                    [prop_uuid],
                )
            )

        # Phase 2: nodes.
        for node_data in dump_data.get("nodes", []):
            node_uuid = _map_node_id(node_data.get("id"))
            if node_uuid is None:
                continue
            kind = _node_kind_from_flags(
                bool(node_data.get("is_class", False)),
                bool(node_data.get("is_page", False)),
                bool(node_data.get("is_day", False)),
                bool(node_data.get("is_month", False)),
                bool(node_data.get("is_year", False)),
                bool(node_data.get("is_template", False)),
            )
            payload: dict[str, Any] = {"nodeId": node_uuid, "kind": kind}
            parent_id = _map_node_id(node_data.get("parent_id"))
            if parent_id is not None:
                payload["parentId"] = parent_id
            sequence = node_data.get("sequence")
            if sequence is not None:
                payload["index"] = str(sequence)
            operations.append(_op("node.create", payload, [node_uuid]))

        # Phase 3: node content.
        for node_data in dump_data.get("nodes", []):
            node_uuid = node_id_map.get(node_data.get("id"))
            if node_uuid is None:
                continue
            name = node_data.get("name")
            if name:
                text = _extract_plain_text(name)
                operations.append(
                    _op(
                        "node.updateContent",
                        {"nodeId": node_uuid, "content": _name_ast(text)},
                        [node_uuid],
                    )
                )

        # Phase 4: node moves (parent / sequence).
        for node_data in dump_data.get("nodes", []):
            node_uuid = node_id_map.get(node_data.get("id"))
            if node_uuid is None:
                continue
            parent_id = _map_node_id(node_data.get("parent_id"))
            sequence = node_data.get("sequence")
            payload = {"nodeId": node_uuid}
            if parent_id is not None:
                payload["newParentId"] = parent_id
            if sequence is not None:
                payload["newIndex"] = str(sequence)
            if len(payload) > 1:
                operations.append(_op("node.move", payload, [node_uuid]))

        # Phase 5: class assignments.
        for node_data in dump_data.get("nodes", []):
            node_uuid = node_id_map.get(node_data.get("id"))
            if node_uuid is None:
                continue
            assigned: set[str] = set()
            for flag, class_key in _FLAG_TO_CLASS_KEY.items():
                if node_data.get(flag):
                    class_uuid = SYSTEM_CLASS_UUIDS[class_key]
                    if class_uuid not in assigned:
                        assigned.add(class_uuid)
                        operations.append(
                            _op(
                                "class.assign",
                                {"nodeId": node_uuid, "classId": class_uuid},
                                [node_uuid, class_uuid],
                            )
                        )
            for class_old_id in node_data.get("class_ids", []) or []:
                class_uuid = _map_node_id(class_old_id)
                if class_uuid and class_uuid not in assigned:
                    assigned.add(class_uuid)
                    operations.append(
                        _op(
                            "class.assign",
                            {"nodeId": node_uuid, "classId": class_uuid},
                            [node_uuid, class_uuid],
                        )
                    )

        # Phase 6: property values.
        for pvs in dump_data.get("property_value_scalars", []):
            node_uuid = node_id_map.get(pvs.get("node_id"))
            prop_uuid = property_id_map.get(pvs.get("property_id"))
            value_id = pvs.get("uuid") or str(uuidv7())
            if remap_uuids and _is_valid_uuid(value_id):
                value_id = uuid_map.get(str(value_id).lower(), generate_uuid())
            if node_uuid is None or prop_uuid is None:
                continue
            prop_type = property_type_map.get(prop_uuid, "text")
            if prop_type == "boolean":
                value = pvs.get("value_boolean")
            elif prop_type == "integer":
                value = pvs.get("value_integer")
            elif prop_type == "float":
                value = pvs.get("value_float")
            else:
                value = pvs.get("value_text")
            if value is None:
                continue
            operations.append(
                _op(
                    "property.set",
                    {
                        "propertyValueId": value_id,
                        "nodeId": node_uuid,
                        "schemaId": prop_uuid,
                        "value": value,
                        "index": 0,
                    },
                    [node_uuid],
                )
            )

        for pvr in dump_data.get("property_value_relations", []):
            node_uuid = node_id_map.get(pvr.get("node_id"))
            prop_uuid = property_id_map.get(pvr.get("property_id"))
            target_uuid = _map_node_id(pvr.get("target_id"))
            value_id = pvr.get("uuid") or str(uuidv7())
            if remap_uuids and _is_valid_uuid(value_id):
                value_id = uuid_map.get(str(value_id).lower(), generate_uuid())
            if node_uuid is None or prop_uuid is None or target_uuid is None:
                continue
            operations.append(
                _op(
                    "property.set",
                    {
                        "propertyValueId": value_id,
                        "nodeId": node_uuid,
                        "schemaId": prop_uuid,
                        "value": target_uuid,
                        "index": pvr.get("order", 0),
                    },
                    [node_uuid, target_uuid],
                )
            )

        for pvsel in dump_data.get("property_value_selections", []):
            node_uuid = node_id_map.get(pvsel.get("node_id"))
            prop_uuid = property_id_map.get(pvsel.get("property_id"))
            line_uuid = _map_selection_line_id(pvsel.get("selection_line_id"))
            value_id = pvsel.get("uuid") or str(uuidv7())
            if remap_uuids and _is_valid_uuid(value_id):
                value_id = uuid_map.get(str(value_id).lower(), generate_uuid())
            if node_uuid is None or prop_uuid is None or line_uuid is None:
                continue
            operations.append(
                _op(
                    "property.set",
                    {
                        "propertyValueId": value_id,
                        "nodeId": node_uuid,
                        "schemaId": prop_uuid,
                        "value": line_uuid,
                        "index": 0,
                    },
                    [node_uuid],
                )
            )

        # Phase 7: class properties.
        for cp in dump_data.get("class_properties", []):
            class_uuid = _map_node_id(cp.get("class_node_id"))
            prop_uuid = property_id_map.get(cp.get("property_id"))
            if class_uuid is None or prop_uuid is None:
                continue
            prop_type = property_type_map.get(prop_uuid, "text")
            default_value = None
            if prop_type == "boolean":
                default_value = cp.get("default_boolean")
            elif prop_type == "integer":
                default_value = cp.get("default_integer")
            elif prop_type == "float":
                default_value = cp.get("default_float")
            elif prop_type in ("node", "relation"):
                default_value = _map_node_id(cp.get("default_node_id"))
            elif prop_type == "selection":
                default_value = _map_selection_line_id(cp.get("default_selection_id"))
            else:
                default_value = cp.get("default_text")
            operations.append(
                _op(
                    "classPropertyEdge.create",
                    {
                        "classId": class_uuid,
                        "propertySchemaId": prop_uuid,
                        "sequence": cp.get("sequence", 0),
                        "hidden": bool(cp.get("hidden", False)),
                        "defaultValue": default_value,
                    },
                    [class_uuid, prop_uuid],
                )
            )

        # Phase 8: class extends.
        extends_map: dict[str, set[str]] = {}
        for ce in dump_data.get("class_extends", []):
            class_uuid = _map_node_id(ce.get("target_id"))
            parent_uuid = _map_node_id(ce.get("source_id"))
            if class_uuid is None or parent_uuid is None:
                continue
            extends_map.setdefault(class_uuid, set()).add(parent_uuid)

        for class_uuid, parents in extends_map.items():
            operations.append(
                _op(
                    "class.update",
                    {"classId": class_uuid, "extends": sorted(parents)},
                    [class_uuid],
                )
            )

        # Phase 9: node views.
        for nv in dump_data.get("node_views", []):
            view_uuid = nv.get("uuid") or str(uuidv7())
            if remap_uuids and _is_valid_uuid(view_uuid):
                view_uuid = uuid_map.get(str(view_uuid).lower(), generate_uuid())
            node_uuid = _map_node_id(nv.get("node_id"))
            if node_uuid is None:
                continue
            query_ast = nv.get("query_json", {})
            if isinstance(query_ast, str):
                try:
                    query_ast = json.loads(query_ast)
                except (json.JSONDecodeError, TypeError):
                    query_ast = {}
            operations.append(
                _op(
                    "nodeView.create",
                    {
                        "viewId": view_uuid,
                        "nodeId": node_uuid,
                        "name": nv.get("name", ""),
                        "viewType": nv.get("view_type", ""),
                        "orderIndex": nv.get("order_index", 0),
                        "isDefault": bool(nv.get("is_default", False)),
                        "shownProperties": nv.get("shown_properties", []),
                        "groupBy": nv.get("group_by"),
                        "viewMode": nv.get("view_mode"),
                        "sortEntries": nv.get("sort_entries", []),
                        "settings": nv.get("settings", {}),
                        "queryAst": query_ast,
                    },
                    [node_uuid, view_uuid],
                )
            )

        return operations

    async def _cleanup_invalid_cloze(self, store: Any) -> int:
        """Unassign the cloze class from nodes that are not children of a card."""
        cloze_uuid = SYSTEM_CLASS_UUIDS["cloze"]
        card_uuid = SYSTEM_CLASS_UUIDS["card"]
        rows = await store.query(
            """
            SELECT n.id, n.parent_id
            FROM node n
            WHERE n.class_ids LIKE ?
            """,
            (f'%"{cloze_uuid}"%',),
        )
        cleaned = 0
        for row in rows:
            parent_id = row["parent_id"]
            is_card_child = False
            if parent_id is not None:
                parent_rows = await store.query(
                    "SELECT class_ids FROM node WHERE id = ?",
                    (parent_id,),
                )
                if parent_rows:
                    parent_class_ids = _load_json(parent_rows[0]["class_ids"], [])
                    is_card_child = card_uuid in parent_class_ids
            if not is_card_child:
                await store.unassign_class(row["id"], cloze_uuid)
                cleaned += 1
        return cleaned

    @staticmethod
    async def _maybe_await(value: Any) -> Any:
        """Await coroutine results from async adapters, pass through sync ones."""
        if asyncio.iscoroutine(value):
            return await value
        return value

    async def delete_all_workspace_data(self, workspace_id: int) -> None:
        """Delete all relay and derived data for a workspace."""
        workspace_uuid = await self._workspace_uuid(workspace_id)
        if not workspace_uuid:
            return

        relay = self._relay()
        max_hlc = await self._maybe_await(relay.get_max_hlc(workspace_uuid))
        if max_hlc.physical > 0 or max_hlc.logical > 0:
            await self._maybe_await(relay.prune_envelopes(workspace_uuid, max_hlc))

        async with acquire_connection(self._pool) as conn:
            await conn.execute(
                "DELETE FROM relay_snapshot WHERE workspace_id = $1",
                workspace_uuid,
            )
            await conn.execute(
                "DELETE FROM compacted_operation_segment WHERE workspace_id = $1",
                workspace_uuid,
            )

        derived_db_path = settings.database_dir / "relay" / "derived" / f"{workspace_uuid}.db"
        if derived_db_path.exists():
            try:
                derived_db_path.unlink()
            except Exception as e:
                logger.error(f"Failed to delete derived DB {derived_db_path}: {e}", exc_info=True)

    async def restore_workspace(
        self,
        workspace_id: int,
        user_id: int,
        dump_data: dict,
        cleanup_invalid_cloze: bool = False,
    ) -> dict:
        """Validate dump, delete all data, import, then bump restore epoch atomically.

        The restore_epoch is incremented only after the import succeeds so that
        a failed import does not trigger a full local-state wipe on clients.
        """
        _validate_dump_schema(dump_data)

        await self.delete_all_workspace_data(workspace_id)
        stats, _ = await self.import_dump(
            workspace_id,
            user_id,
            dump_data,
            remap_uuids=False,
            cleanup_invalid_cloze=cleanup_invalid_cloze,
        )

        async with acquire_connection(self._pool) as conn, conn.transaction():
            await conn.execute(
                "UPDATE workspace SET restore_epoch = restore_epoch + 1, write_date = NOW() WHERE id = $1",
                workspace_id,
            )
        return stats

    async def list_page_uuids(self, workspace_id: int) -> list[dict]:
        """List active page UUIDs and names."""
        workspace_uuid = await self._workspace_uuid(workspace_id)
        if not workspace_uuid:
            return []
        store = self._store(workspace_uuid, workspace_uuid)
        try:
            await store.sync()
            rows = await store.query(
                "SELECT id, content FROM node WHERE workspace_id = ? AND kind = ?",
                (workspace_uuid, "page"),
            )
            return [
                {"uuid": row["id"], "name": _extract_plain_text(_load_json(row["content"], []))}
                for row in rows
            ]
        finally:
            await store.close()

    async def list_asset_uuids(self, workspace_id: int) -> list[dict]:
        """List active asset UUIDs and names."""
        workspace_uuid = await self._workspace_uuid(workspace_id)
        if not workspace_uuid:
            return []
        asset_class = SYSTEM_CLASS_UUIDS["asset"]
        store = self._store(workspace_uuid, workspace_uuid)
        try:
            await store.sync()
            rows = await store.query(
                "SELECT id, content FROM node WHERE workspace_id = ? AND class_ids LIKE ?",
                (workspace_uuid, f'%"{asset_class}"%'),
            )
            return [
                {"uuid": row["id"], "name": _extract_plain_text(_load_json(row["content"], []))}
                for row in rows
            ]
        finally:
            await store.close()

    async def list_asset_files(self, workspace_id: int) -> list[dict]:
        """List active asset UUIDs with their content file hash and mime_type."""
        workspace_uuid = await self._workspace_uuid(workspace_id)
        if not workspace_uuid:
            return []
        store = self._store(workspace_uuid, workspace_uuid)
        try:
            await store.sync()
            rows = await store.query(
                """
                SELECT n.id AS uuid, na.asset_hash AS hash, na.mime_type
                FROM node n
                JOIN node_asset na ON na.node_id = n.id
                WHERE n.workspace_id = ?
                """,
                (workspace_uuid,),
            )
            return [dict(r) for r in rows]
        finally:
            await store.close()

    async def get_page_metadata(
        self, workspace_id: int, node_uuid: str, include_properties: bool = True
    ) -> dict:
        """Fetch full page metadata for YAML frontmatter."""
        workspace_uuid = await self._workspace_uuid(workspace_id)
        if not workspace_uuid:
            raise ValueError(f"Workspace {workspace_id} not found")
        store = self._store(workspace_uuid, workspace_uuid)
        try:
            await store.sync()
            node_rows = await store.query(
                "SELECT id, kind, class_ids, parent_id, content, created_at, updated_at FROM node WHERE id = ?",
                (node_uuid,),
            )
            if not node_rows:
                raise ValueError(f"Node not found: {node_uuid}")
            node_row = node_rows[0]
            content = _load_json(node_row["content"], [])
            class_ids = _load_json(node_row["class_ids"], [])

            metadata: dict[str, Any] = {
                "uuid": node_row["id"],
                "create_date": node_row["created_at"],
                "write_date": node_row["updated_at"],
                "title": _extract_plain_text(content),
            }

            ancestors = []
            current_parent = node_row["parent_id"]
            visited = set()
            while current_parent and current_parent not in visited:
                visited.add(current_parent)
                parent_rows = await store.query(
                    "SELECT id, content FROM node WHERE id = ?",
                    (current_parent,),
                )
                if not parent_rows:
                    break
                parent_row = parent_rows[0]
                ancestors.insert(
                    0,
                    {
                        "uuid": parent_row["id"],
                        "title": _extract_plain_text(_load_json(parent_row["content"], [])),
                    },
                )
                current_parent = parent_row["parent_id"]
            if ancestors:
                metadata["parents"] = ancestors

            if class_ids:
                placeholders = ",".join("?" for _ in class_ids)
                class_rows = await store.query(
                    f"SELECT id, content FROM node WHERE id IN ({placeholders})",
                    tuple(class_ids),
                )
                metadata["classes"] = [
                    {"uuid": r["id"], "name": _extract_plain_text(_load_json(r["content"], []))}
                    for r in class_rows
                ]

            if include_properties:
                prop_rows = await store.query(
                    """
                    SELECT ps.name AS property_name, ps.type AS property_type, ps.multi, ps.options,
                           pv.value AS raw_value
                    FROM property_value pv
                    JOIN property_schema ps ON ps.id = pv.property_schema_id
                    WHERE pv.node_id = ? AND ps.active = 1
                    ORDER BY ps.name
                    """,
                    (node_uuid,),
                )
                props_out: dict[str, Any] = {}
                for row in prop_rows:
                    prop_name = row["property_name"]
                    prop_type = row["property_type"]
                    raw_value = _load_json(row["raw_value"], None)
                    value: Any = None
                    if prop_type in ("node", "relation"):
                        target_rows = await store.query(
                            "SELECT content FROM node WHERE id = ?",
                            (raw_value,),
                        )
                        value = {
                            "uuid": raw_value,
                            "name": _extract_plain_text(
                                _load_json(target_rows[0]["content"], []) if target_rows else []
                            ),
                        }
                    elif prop_type == "selection":
                        options = _load_json(row["options"], [])
                        value = next(
                            (opt.get("name", "") for opt in options if opt.get("id") == raw_value),
                            None,
                        )
                    else:
                        value = raw_value
                    if value is not None:
                        existing = props_out.get(prop_name)
                        if existing is None:
                            props_out[prop_name] = value
                        elif isinstance(existing, list):
                            existing.append(value)
                        else:
                            props_out[prop_name] = [existing, value]
                if props_out:
                    metadata["properties"] = props_out

            return metadata
        finally:
            await store.close()


def _load_json(value: Any, default: Any) -> Any:
    """Parse a JSON string or pass through a parsed value."""
    if value is None:
        return default
    if isinstance(value, str):
        try:
            return json.loads(value)
        except (json.JSONDecodeError, TypeError):
            return default
    return value


def _validate_dump_schema(dump_data: dict) -> None:
    """Validate a workspace dump schema before importing it.

    Raises:
        ValueError: If the dump is missing required fields or has an
            unsupported version.
    """
    if not isinstance(dump_data, dict):
        raise ValueError("Dump data must be a JSON object")

    version = dump_data.get("version")
    if version != 3:
        raise ValueError(f"Unsupported dump version: {version!r}")

    workspace = dump_data.get("workspace")
    if not isinstance(workspace, dict):
        raise ValueError("Dump is missing 'workspace' object")
    if not _is_valid_uuid(workspace.get("uuid")):
        raise ValueError("Dump workspace is missing a valid uuid")

    nodes = dump_data.get("nodes")
    if not isinstance(nodes, list):
        raise ValueError("Dump is missing 'nodes' list")

    for key in ("links", "properties", "property_selection_lines", "node_views"):
        value = dump_data.get(key)
        if value is not None and not isinstance(value, list):
            raise ValueError(f"Dump '{key}' must be a list")
