"""PostgreSQL implementation of the UndoRepository."""

from __future__ import annotations

import json
from typing import Any

import asyncpg

from ...db.connection import acquire_connection
from ...db.schema.constants import SYSTEM_CLASS_UUIDS
from ...logging_config import get_logger
from .base import BasePostgresRepository
from .interfaces import UndoRepository

logger = get_logger(__name__)

# Maximum entries per user per workspace
MAX_UNDO_ENTRIES = 200


class PostgresUndoRepository(BasePostgresRepository, UndoRepository):
    """PostgreSQL implementation of the undo / redo log.

    All SQL that was previously inline in ``UndoService`` lives here so that
    the service layer depends only on the ``UndoRepository`` interface.
    """

    # ------------------------------------------------------------------
    # Recording
    # ------------------------------------------------------------------

    async def record(
        self,
        operation: str,
        entity_type: str,
        entity_id: int,
        before_state: dict | None,
        after_state: dict | None,
        description: str = "",
    ) -> None:
        """Append an entry to the undo log.

        Also clears any redo entries (entries that were undone) since a new
        action invalidates the redo stack, and trims old entries.
        """
        async with acquire_connection(self._pool) as conn, conn.transaction():
            # Clear redo stack (any undone entries)
            await conn.execute(
                "DELETE FROM undo_log WHERE workspace_id = $1 AND user_id = $2 AND is_undone = TRUE",
                self._workspace_id,
                self._user_id,
            )

            # Insert new entry
            await conn.execute(
                """
                    INSERT INTO undo_log
                        (workspace_id, user_id, operation, entity_type, entity_id,
                         before_state, after_state, description)
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                """,
                self._workspace_id,
                self._user_id,
                operation,
                entity_type,
                entity_id,
                json.dumps(before_state) if before_state is not None else None,
                json.dumps(after_state) if after_state is not None else None,
                description,
            )

            # Trim: keep only the most recent MAX_UNDO_ENTRIES
            await conn.execute(
                """
                    DELETE FROM undo_log
                    WHERE id IN (
                        SELECT id FROM undo_log
                        WHERE workspace_id = $1 AND user_id = $2 AND is_undone = FALSE
                        ORDER BY created_at DESC
                        OFFSET $3
                    )
                """,
                self._workspace_id,
                self._user_id,
                MAX_UNDO_ENTRIES,
            )

    # ------------------------------------------------------------------
    # Undo / Redo
    # ------------------------------------------------------------------

    async def get_undo(self) -> dict | None:
        """Return the most recent non-undone entry, or None if empty."""
        async with acquire_connection(self._pool) as conn:
            row = await conn.fetchrow(
                """
                SELECT * FROM undo_log
                WHERE workspace_id = $1 AND user_id = $2 AND is_undone = FALSE
                ORDER BY created_at DESC
                LIMIT 1
            """,
                self._workspace_id,
                self._user_id,
            )
            return self._entry_from_row(row) if row else None

    async def get_redo(self) -> dict | None:
        """Return the most recently undone entry, or None if empty."""
        async with acquire_connection(self._pool) as conn:
            row = await conn.fetchrow(
                """
                SELECT * FROM undo_log
                WHERE workspace_id = $1 AND user_id = $2 AND is_undone = TRUE
                ORDER BY created_at ASC
                LIMIT 1
            """,
                self._workspace_id,
                self._user_id,
            )
            return self._entry_from_row(row) if row else None

    async def undo(self) -> dict | None:
        """Undo the most recent operation and mark it undone."""
        async with acquire_connection(self._pool) as conn:
            row = await conn.fetchrow(
                """
                SELECT * FROM undo_log
                WHERE workspace_id = $1 AND user_id = $2 AND is_undone = FALSE
                ORDER BY created_at DESC
                LIMIT 1
            """,
                self._workspace_id,
                self._user_id,
            )

            if not row:
                return None

            entry = self._entry_from_row(row)
            await self._apply_undo(
                conn,
                entry["operation"],
                entry["entity_id"],
                entry["before_state"],
                entry["after_state"],
            )
            await conn.execute(
                "UPDATE undo_log SET is_undone = TRUE WHERE id = $1",
                entry["id"],
            )

        return {
            "operation": entry["operation"],
            "entity_type": entry["entity_type"],
            "entity_id": entry["entity_id"],
            "description": entry["description"],
        }

    async def redo(self) -> dict | None:
        """Redo the most recently undone operation and mark it not undone."""
        async with acquire_connection(self._pool) as conn:
            row = await conn.fetchrow(
                """
                SELECT * FROM undo_log
                WHERE workspace_id = $1 AND user_id = $2 AND is_undone = TRUE
                ORDER BY created_at ASC
                LIMIT 1
            """,
                self._workspace_id,
                self._user_id,
            )

            if not row:
                return None

            entry = self._entry_from_row(row)
            await self._apply_redo(
                conn,
                entry["operation"],
                entry["entity_id"],
                entry["before_state"],
                entry["after_state"],
            )
            await conn.execute(
                "UPDATE undo_log SET is_undone = FALSE WHERE id = $1",
                entry["id"],
            )

        return {
            "operation": entry["operation"],
            "entity_type": entry["entity_type"],
            "entity_id": entry["entity_id"],
            "description": entry["description"],
        }

    # ------------------------------------------------------------------
    # Stack info
    # ------------------------------------------------------------------

    async def get_undo_entries(self) -> list[dict]:
        """Return all non-undone entries ordered newest first."""
        async with acquire_connection(self._pool) as conn:
            rows = await conn.fetch(
                "SELECT * FROM undo_log "
                "WHERE workspace_id=$1 AND user_id=$2 AND is_undone=FALSE "
                "ORDER BY created_at DESC LIMIT 50",
                self._workspace_id,
                self._user_id,
            )
        return [self._entry_from_row(r) for r in rows]

    async def get_redo_entries(self) -> list[dict]:
        """Return all undone entries ordered oldest first."""
        async with acquire_connection(self._pool) as conn:
            rows = await conn.fetch(
                "SELECT * FROM undo_log "
                "WHERE workspace_id=$1 AND user_id=$2 AND is_undone=TRUE "
                "ORDER BY created_at ASC LIMIT 50",
                self._workspace_id,
                self._user_id,
            )
        return [self._entry_from_row(r) for r in rows]

    async def undo_to(self, entry_id: int) -> list[dict]:
        """Undo all operations from the top of the stack down to (and including) entry_id."""
        results: list[dict] = []
        async with acquire_connection(self._pool) as conn:
            rows = await conn.fetch(
                "SELECT * FROM undo_log "
                "WHERE workspace_id=$1 AND user_id=$2 AND is_undone=FALSE "
                "ORDER BY created_at DESC",
                self._workspace_id,
                self._user_id,
            )
            for row in rows:
                entry = self._entry_from_row(row)
                await self._apply_undo(
                    conn,
                    entry["operation"],
                    entry["entity_id"],
                    entry["before_state"],
                    entry["after_state"],
                )
                await conn.execute("UPDATE undo_log SET is_undone = TRUE WHERE id = $1", entry["id"])
                results.append(
                    {
                        "operation": entry["operation"],
                        "entity_type": entry["entity_type"],
                        "entity_id": entry["entity_id"],
                        "description": entry["description"],
                    }
                )
                if entry["id"] == entry_id:
                    break
        return results

    async def redo_to(self, entry_id: int) -> list[dict]:
        """Redo all operations from the oldest undone up to (and including) entry_id."""
        results: list[dict] = []
        async with acquire_connection(self._pool) as conn:
            rows = await conn.fetch(
                "SELECT * FROM undo_log "
                "WHERE workspace_id=$1 AND user_id=$2 AND is_undone=TRUE "
                "ORDER BY created_at ASC",
                self._workspace_id,
                self._user_id,
            )
            for row in rows:
                entry = self._entry_from_row(row)
                await self._apply_redo(
                    conn,
                    entry["operation"],
                    entry["entity_id"],
                    entry["before_state"],
                    entry["after_state"],
                )
                await conn.execute("UPDATE undo_log SET is_undone = FALSE WHERE id = $1", entry["id"])
                results.append(
                    {
                        "operation": entry["operation"],
                        "entity_type": entry["entity_type"],
                        "entity_id": entry["entity_id"],
                        "description": entry["description"],
                    }
                )
                if entry["id"] == entry_id:
                    break
        return results

    async def clear(self) -> None:
        """Delete all undo/redo entries for the current user+workspace."""
        async with acquire_connection(self._pool) as conn:
            await conn.execute(
                "DELETE FROM undo_log WHERE workspace_id = $1 AND user_id = $2",
                self._workspace_id,
                self._user_id,
            )

    async def clear_for_node(self, node_id: int) -> None:
        """Delete all undo/redo entries affecting the given node."""
        async with acquire_connection(self._pool) as conn:
            await conn.execute(
                "DELETE FROM undo_log WHERE workspace_id = $1 AND user_id = $2 AND entity_id = $3",
                self._workspace_id,
                self._user_id,
                node_id,
            )

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------

    @staticmethod
    def _entry_from_row(row: asyncpg.Record) -> dict[str, Any]:
        """Convert a database row into a parsed entry dict."""
        return {
            "id": row["id"],
            "operation": row["operation"],
            "entity_type": row["entity_type"],
            "entity_id": row["entity_id"],
            "before_state": json.loads(row["before_state"]) if row["before_state"] else None,
            "after_state": json.loads(row["after_state"]) if row["after_state"] else None,
            "description": row["description"],
            "created_at": row["created_at"],
        }

    # ------------------------------------------------------------------
    # Apply helpers
    # ------------------------------------------------------------------

    async def _apply_undo(
        self,
        conn: asyncpg.Connection,
        operation: str,
        entity_id: int,
        before_state: dict | None,
        after_state: dict | None,
    ) -> None:
        """Restore ``before_state`` to reverse the operation."""
        if operation == "create_node":
            # Undo create => soft-delete the node
            await conn.execute(
                "UPDATE node SET is_deleted = TRUE, deleted_at = NOW() WHERE id = $1 AND workspace_id = $2",
                entity_id,
                self._workspace_id,
            )
        elif operation == "delete_node":
            # Undo delete => restore the node (and descendants)
            if before_state:
                deleted_ids = before_state.get("deleted_ids", [entity_id])
                await conn.execute(
                    "UPDATE node SET is_deleted = FALSE, deleted_at = NULL WHERE id = ANY($1::integer[]) AND workspace_id = $2",
                    deleted_ids,
                    self._workspace_id,
                )
        elif operation in ("update_node", "move_node"):
            if before_state:
                await self._restore_node_columns(conn, entity_id, before_state)
        elif operation in ("archive_node", "unarchive_node"):
            if before_state:
                await conn.execute(
                    "UPDATE node SET active = $1, write_date = NOW() WHERE id = $2 AND workspace_id = $3",
                    before_state.get("active", True),
                    entity_id,
                    self._workspace_id,
                )
        elif operation in ("add_class", "remove_class"):
            if before_state:
                await conn.execute(
                    "UPDATE node SET class_ids = $1, write_date = NOW(), version = version + 1 WHERE id = $2 AND workspace_id = $3",
                    before_state["class_ids"],
                    entity_id,
                    self._workspace_id,
                )
                # Re-compute flags
                await self._recompute_class_flags(conn, entity_id, before_state["class_ids"])
        elif operation == "set_property":
            if before_state and before_state.get("had_value"):
                await self._restore_property_value(conn, entity_id, before_state)
            elif before_state:
                # Had no value before — remove it
                prop_id = before_state["property_id"]
                await self._delete_property_value(conn, entity_id, prop_id, before_state.get("property_type", ""))
        elif operation == "remove_property" and before_state and before_state.get("had_value"):
            await self._restore_property_value(conn, entity_id, before_state)

    async def _apply_redo(
        self,
        conn: asyncpg.Connection,
        operation: str,
        entity_id: int,
        before_state: dict | None,
        after_state: dict | None,
    ) -> None:
        """Re-apply ``after_state`` to redo the operation."""
        if operation == "create_node":
            # Redo create => un-delete the node
            await conn.execute(
                "UPDATE node SET is_deleted = FALSE, deleted_at = NULL WHERE id = $1 AND workspace_id = $2",
                entity_id,
                self._workspace_id,
            )
        elif operation == "delete_node":
            # Redo delete => soft-delete again
            if before_state:
                deleted_ids = before_state.get("deleted_ids", [entity_id])
                await conn.execute(
                    "UPDATE node SET is_deleted = TRUE, deleted_at = NOW() WHERE id = ANY($1::integer[]) AND workspace_id = $2",
                    deleted_ids,
                    self._workspace_id,
                )
        elif operation in ("update_node", "move_node"):
            if after_state:
                await self._restore_node_columns(conn, entity_id, after_state)
        elif operation in ("archive_node", "unarchive_node"):
            if after_state:
                await conn.execute(
                    "UPDATE node SET active = $1, write_date = NOW() WHERE id = $2 AND workspace_id = $3",
                    after_state.get("active", True),
                    entity_id,
                    self._workspace_id,
                )
        elif operation in ("add_class", "remove_class"):
            if after_state:
                await conn.execute(
                    "UPDATE node SET class_ids = $1, write_date = NOW(), version = version + 1 WHERE id = $2 AND workspace_id = $3",
                    after_state["class_ids"],
                    entity_id,
                    self._workspace_id,
                )
                await self._recompute_class_flags(conn, entity_id, after_state["class_ids"])
        elif operation == "set_property":
            if after_state and after_state.get("had_value"):
                await self._restore_property_value(conn, entity_id, after_state)
        elif operation == "remove_property" and after_state:
            prop_id = after_state["property_id"]
            await self._delete_property_value(conn, entity_id, prop_id, after_state.get("property_type", ""))

    # ------------------------------------------------------------------
    # Low-level restore
    # ------------------------------------------------------------------

    async def _restore_node_columns(self, conn: asyncpg.Connection, node_id: int, state: dict) -> None:
        """Write back the columns captured in a before/after snapshot."""
        sets: list[str] = []
        vals: list[Any] = []
        idx = 1

        for col in ("name", "icon", "color", "parent_id", "sequence", "collapsed"):
            if col in state:
                idx += 1
                sets.append(f"{col} = ${idx}")
                vals.append(state[col])

        if not sets:
            return

        sets.append("write_date = NOW()")
        sets.append("version = version + 1")

        sql = f"UPDATE node SET {', '.join(sets)} WHERE id = $1 AND workspace_id = ${idx + 1}"
        vals = [node_id] + vals + [self._workspace_id]
        await conn.execute(sql, *vals)

    async def _recompute_class_flags(self, conn: asyncpg.Connection, node_id: int, class_ids: list) -> None:
        """Recompute is_* flag columns from class_ids by resolving UUIDs."""
        uuid_to_flag = {
            SYSTEM_CLASS_UUIDS["class"]: "is_class",
            SYSTEM_CLASS_UUIDS["page"]: "is_page",
            SYSTEM_CLASS_UUIDS["day"]: "is_day",
            SYSTEM_CLASS_UUIDS["month"]: "is_month",
            SYSTEM_CLASS_UUIDS["year"]: "is_year",
            SYSTEM_CLASS_UUIDS["asset"]: "is_asset",
            SYSTEM_CLASS_UUIDS["template"]: "is_template",
            SYSTEM_CLASS_UUIDS["comment"]: "is_comment",
        }

        # Resolve class_ids to UUIDs
        if class_ids:
            rows = await conn.fetch(
                "SELECT id, uuid FROM node WHERE id = ANY($1::integer[])",
                class_ids,
            )
            uuid_map = {r["id"]: r["uuid"] for r in rows}
        else:
            uuid_map = {}

        flags = dict.fromkeys(uuid_to_flag.values(), False)
        for cid in class_ids:
            uuid_val = uuid_map.get(cid)
            if uuid_val and uuid_val in uuid_to_flag:
                flags[uuid_to_flag[uuid_val]] = True

        sets = ", ".join(f"{k} = {'TRUE' if v else 'FALSE'}" for k, v in flags.items())
        await conn.execute(
            f"UPDATE node SET {sets} WHERE id = $1 AND workspace_id = $2",
            node_id,
            self._workspace_id,
        )

    async def _restore_property_value(self, conn: asyncpg.Connection, node_id: int, state: dict) -> None:
        """Restore a property value from a snapshot."""
        prop_id = state["property_id"]
        prop_type = state.get("property_type", "")
        value = state.get("value")

        if prop_type in ("integer", "float", "boolean"):
            # Scalar
            await conn.execute(
                """
                INSERT INTO property_value_scalar (node_id, property_id, value, workspace_id)
                VALUES ($1, $2, $3, $4)
                ON CONFLICT (node_id, property_id) DO UPDATE SET value = $3
            """,
                node_id,
                prop_id,
                value,
                self._workspace_id,
            )
        elif prop_type in ("node", "text", "image", "date"):
            # Relation — value is a target_node_id (or list of them for multi)
            # First remove existing
            await conn.execute(
                "DELETE FROM property_value_relation WHERE node_id = $1 AND property_id = $2 AND workspace_id = $3",
                node_id,
                prop_id,
                self._workspace_id,
            )
            if isinstance(value, list):
                for i, v in enumerate(value):
                    await conn.execute(
                        """
                        INSERT INTO property_value_relation (node_id, property_id, target_node_id, sequence, workspace_id)
                        VALUES ($1, $2, $3, $4, $5)
                    """,
                        node_id,
                        prop_id,
                        v,
                        i,
                        self._workspace_id,
                    )
            elif value is not None:
                await conn.execute(
                    """
                    INSERT INTO property_value_relation (node_id, property_id, target_node_id, sequence, workspace_id)
                    VALUES ($1, $2, $3, 0, $4)
                """,
                    node_id,
                    prop_id,
                    value,
                    self._workspace_id,
                )
        elif prop_type == "selection":
            await conn.execute(
                "DELETE FROM property_value_selection WHERE node_id = $1 AND property_id = $2 AND workspace_id = $3",
                node_id,
                prop_id,
                self._workspace_id,
            )
            if isinstance(value, list):
                for i, v in enumerate(value):
                    await conn.execute(
                        """
                        INSERT INTO property_value_selection (node_id, property_id, selection_line_id, sequence, workspace_id)
                        VALUES ($1, $2, $3, $4, $5)
                    """,
                        node_id,
                        prop_id,
                        v,
                        i,
                        self._workspace_id,
                    )
            elif value is not None:
                await conn.execute(
                    """
                    INSERT INTO property_value_selection (node_id, property_id, selection_line_id, sequence, workspace_id)
                    VALUES ($1, $2, $3, 0, $4)
                """,
                    node_id,
                    prop_id,
                    value,
                    self._workspace_id,
                )

    async def _delete_property_value(
        self, conn: asyncpg.Connection, node_id: int, prop_id: int, prop_type: str
    ) -> None:
        """Remove a property value entirely."""
        if prop_type in ("integer", "float", "boolean"):
            await conn.execute(
                "DELETE FROM property_value_scalar WHERE node_id=$1 AND property_id=$2 AND workspace_id=$3",
                node_id,
                prop_id,
                self._workspace_id,
            )
        elif prop_type in ("node", "text", "image", "date"):
            await conn.execute(
                "DELETE FROM property_value_relation WHERE node_id=$1 AND property_id=$2 AND workspace_id=$3",
                node_id,
                prop_id,
                self._workspace_id,
            )
        elif prop_type == "selection":
            await conn.execute(
                "DELETE FROM property_value_selection WHERE node_id=$1 AND property_id=$2 AND workspace_id=$3",
                node_id,
                prop_id,
                self._workspace_id,
            )
        # Also remove from node_property
        await conn.execute(
            "DELETE FROM node_property WHERE node_id=$1 AND property_id=$2 AND workspace_id=$3",
            node_id,
            prop_id,
            self._workspace_id,
        )
