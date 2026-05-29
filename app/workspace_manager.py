"""Workspace management operations for Notees.

Handles workspace CRUD: listing, creating, switching, renaming, deleting.
Import/export orchestration is forwarded to workspace_io.
"""

import shutil
from typing import Any

from .db.connection import get_connection, get_workspace_dir
from .db.schema.init import seed_workspace
from .logging_config import get_logger

logger = get_logger(__name__)

# Track active workspace per user (in-memory, for session)
# Maps user_id (str) -> workspace UUID (str)
_active_workspaces: dict[str, str] = {}


async def _get_numeric_user_id(user_id: str) -> int | None:
    """Convert string user_id to numeric PostgreSQL ID."""
    async with get_connection() as conn:
        row = await conn.fetchrow('SELECT id FROM "user" WHERE id::text = $1 OR uuid::text = $1', user_id)
        return row["id"] if row else None


async def list_workspaces(user_id: str) -> list[dict[str, Any]]:
    """List all workspaces accessible to a user (owned + shared)."""
    numeric_user_id = await _get_numeric_user_id(user_id)
    if not numeric_user_id:
        return []

    async with get_connection() as conn:
        rows = await conn.fetch(
            """
            SELECT DISTINCT g.uuid, g.name, g.create_date, g.write_date, g.is_shared
            FROM workspace g
            LEFT JOIN workspace_share gs ON g.id = gs.workspace_id
            WHERE g.create_uid = $1 OR gs.user_id = $1
            ORDER BY g.create_date DESC
            """,
            numeric_user_id,
        )
        return [
            {
                "uuid": str(row["uuid"]),
                "name": row["name"],
                "created_at": row["create_date"].isoformat() if row["create_date"] else None,
                "updated_at": row["write_date"].isoformat() if row["write_date"] else None,
                "is_shared": row["is_shared"],
            }
            for row in rows
        ]


def get_active_workspace_id(user_id: str) -> str | None:
    """Get the active workspace UUID for a user."""
    return _active_workspaces.get(user_id)


async def create_workspace(user_id: str, name: str) -> dict[str, Any]:
    """Create a new workspace for a user.

    Raises:
        ValueError: If user not found or workspace name exists.
        RuntimeError: If creation fails.
    """
    numeric_user_id = await _get_numeric_user_id(user_id)
    if not numeric_user_id:
        raise ValueError(f"User not found: {user_id}")

    async with get_connection() as conn:
        existing = await conn.fetchrow(
            "SELECT id FROM workspace WHERE create_uid = $1 AND name = $2 AND active = TRUE", numeric_user_id, name
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
            numeric_user_id,
        )
        if row is None:
            raise RuntimeError("Failed to create workspace")

        workspace_id = row["id"]
        logger.info(f"Seeding workspace {workspace_id} with system data")
        await seed_workspace(conn, workspace_id, numeric_user_id)

        _active_workspaces[user_id] = str(row["uuid"])
        return {
            "uuid": str(row["uuid"]),
            "name": row["name"],
            "created_at": row["create_date"].isoformat() if row["create_date"] else None,
        }


async def switch_workspace(user_id: str, workspace_uuid: str) -> bool:
    """Switch to a different workspace. Returns True on success."""
    numeric_user_id = await _get_numeric_user_id(user_id)
    if not numeric_user_id:
        return False

    async with get_connection() as conn:
        workspace = await conn.fetchrow(
            """
            SELECT g.id FROM workspace g
            LEFT JOIN workspace_share gs ON g.id = gs.workspace_id
            WHERE g.uuid::text = $1 AND g.active = TRUE
              AND (g.create_uid = $2 OR gs.user_id = $2)
            """,
            workspace_uuid,
            numeric_user_id,
        )
        if not workspace:
            return False

        _active_workspaces[user_id] = workspace_uuid
        return True


async def rename_workspace(user_id: str, old_name: str, new_name: str) -> dict[str, Any]:
    """Rename a workspace (owner only).

    Raises:
        ValueError: If user/workspace not found or new name already exists.
        RuntimeError: If rename fails.
    """
    numeric_user_id = await _get_numeric_user_id(user_id)
    if not numeric_user_id:
        raise ValueError(f"User not found: {user_id}")

    async with get_connection() as conn:
        old_workspace = await conn.fetchrow(
            "SELECT id, uuid FROM workspace WHERE create_uid = $1 AND name = $2 AND active = TRUE",
            numeric_user_id,
            old_name,
        )
        if not old_workspace:
            raise ValueError(f"Workspace '{old_name}' not found")

        existing = await conn.fetchrow(
            "SELECT id FROM workspace WHERE create_uid = $1 AND name = $2 AND active = TRUE", numeric_user_id, new_name
        )
        if existing:
            raise ValueError(f"Workspace '{new_name}' already exists")

        row = await conn.fetchrow(
            """
            UPDATE workspace SET name = $1, write_date = NOW(), write_uid = $3
            WHERE id = $2
            RETURNING uuid, name, create_date
            """,
            new_name,
            old_workspace["id"],
            numeric_user_id,
        )
        if row is None:
            raise RuntimeError("Failed to rename workspace")

        if _active_workspaces.get(user_id) == old_name:
            _active_workspaces[user_id] = new_name

        return {
            "uuid": str(row["uuid"]),
            "name": row["name"],
            "created_at": row["create_date"].isoformat() if row["create_date"] else None,
        }


async def delete_workspace(user_id: str, workspace_uuid: str) -> bool:
    """Delete a workspace (owner only). Hard-deletes DB record and assets folder.

    Large workspaces disable node triggers during bulk deletion to avoid
    per-row trigger overhead for 21k+ node workspaces.
    """
    numeric_user_id = await _get_numeric_user_id(user_id)
    if not numeric_user_id:
        return False

    async with get_connection() as conn:
        workspace_row = await conn.fetchrow(
            "SELECT id, uuid FROM workspace WHERE create_uid = $1 AND uuid::text = $2",
            numeric_user_id,
            workspace_uuid,
            timeout=None,
        )
        if not workspace_row:
            return False

        workspace_id = workspace_row["id"]
        workspace_uuid = str(workspace_row["uuid"])

        # Large workspaces (21k+ nodes) blow the 60-second pool command_timeout because
        # PostgreSQL's per-row triggers fire for every affected node.
        # Fix: disable all user triggers on the node table for the duration of this
        # operation. The notees DB user is the table owner so this is permitted.
        _BIG = 600  # 10-minute ceiling for bulk workspace deletion

        await conn.execute("ALTER TABLE node DISABLE TRIGGER ALL", timeout=_BIG)
        try:
            await conn.execute(
                "DELETE FROM node_activity WHERE node_id IN (SELECT id FROM node WHERE workspace_id = $1)",
                workspace_id,
                timeout=_BIG,
            )
            await conn.execute(
                """DELETE FROM link_click
                   WHERE source_node_id IN (SELECT id FROM node WHERE workspace_id = $1)
                      OR target_node_id IN (SELECT id FROM node WHERE workspace_id = $1)""",
                workspace_id,
                timeout=_BIG,
            )
            await conn.execute("DELETE FROM node WHERE workspace_id = $1", workspace_id, timeout=_BIG)
        finally:
            await conn.execute("ALTER TABLE node ENABLE TRIGGER ALL", timeout=_BIG)

        await conn.execute("DELETE FROM property WHERE workspace_id = $1", workspace_id, timeout=_BIG)
        result = await conn.execute("DELETE FROM workspace WHERE id = $1", workspace_id, timeout=_BIG)

        deleted = result.split()[-1] != "0"

        if deleted:
            workspace_dir_path = get_workspace_dir(workspace_uuid)
            if workspace_dir_path.exists():
                try:
                    shutil.rmtree(workspace_dir_path)
                    logger.info(f"Deleted workspace folder: {workspace_dir_path}")
                except Exception as e:
                    logger.error(f"Failed to delete workspace folder {workspace_dir_path}: {e}", exc_info=True)

            if _active_workspaces.get(user_id) == workspace_uuid:
                del _active_workspaces[user_id]

        return deleted
