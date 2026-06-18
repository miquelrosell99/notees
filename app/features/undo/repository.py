"""PostgreSQL implementation of the UndoRepository."""

from __future__ import annotations

import json
from typing import Any

import asyncpg

from app.db.connection import acquire_connection
from app.domain.repositories.base import BasePostgresRepository
from app.features.undo.port import UndoRepository
from app.logging_config import get_logger

from ...db.schema.constants import SYSTEM_CLASS_UUIDS

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
                before_state,
                after_state,
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
        async with acquire_connection(self._pool) as conn, conn.transaction():
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
        async with acquire_connection(self._pool) as conn, conn.transaction():
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
        """Convert a database row into a parsed entry dict.

        asyncpg returns JSONB columns as native Python dicts/lists, so we
        return them directly. Strings (legacy stored JSON text) are parsed
        defensively.
        """

        def _parse(value: Any) -> Any:
            if value is None:
                return None
            if isinstance(value, str):
                return json.loads(value)
            return value

        return {
            "id": row["id"],
            "operation": row["operation"],
            "entity_type": row["entity_type"],
            "entity_id": row["entity_id"],
            "before_state": _parse(row["before_state"]),
            "after_state": _parse(row["after_state"]),
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
                await self._restore_class_state(conn, entity_id, before_state)
        elif operation == "set_property":
            if before_state:
                if before_state.get("had_assignment", before_state.get("had_value", False)):
                    await self._restore_property_value(conn, entity_id, before_state)
                else:
                    # Had no assignment before — remove it entirely
                    prop_id = before_state["property_id"]
                    await self._delete_property_value(conn, entity_id, prop_id, before_state.get("property_type", ""))
        elif operation == "remove_property" and before_state:
            await self._restore_property_value(conn, entity_id, before_state)
        elif operation in ("add_tag_link", "remove_tag_link") and before_state:
            await self._restore_tag_ids(conn, entity_id, before_state)
        elif operation in ("add_alias", "remove_alias") and before_state:
            await self._restore_alias(conn, before_state)

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
                await self._restore_class_state(conn, entity_id, after_state)
        elif operation == "set_property":
            if after_state:
                if after_state.get("removed"):
                    prop_id = after_state["property_id"]
                    await self._delete_property_value(conn, entity_id, prop_id, after_state.get("property_type", ""))
                elif after_state.get("had_assignment", after_state.get("had_value", False)):
                    await self._restore_property_value(conn, entity_id, after_state)
        elif operation == "remove_property" and after_state:
            prop_id = after_state["property_id"]
            await self._delete_property_value(conn, entity_id, prop_id, after_state.get("property_type", ""))
        elif operation in ("add_tag_link", "remove_tag_link") and after_state:
            await self._restore_tag_ids(conn, entity_id, after_state)
        elif operation in ("add_alias", "remove_alias") and after_state:
            await self._restore_alias(conn, after_state)

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

    async def _restore_class_state(self, conn: asyncpg.Connection, node_id: int, state: dict) -> None:
        """Restore class_ids, tag_ids, classes_path, and recompute flags."""
        class_ids = state.get("class_ids", [])
        set_clauses = ["class_ids = $2", "write_date = NOW()", "version = version + 1"]
        vals: list[Any] = [node_id, class_ids]
        param_idx = 2

        if "tag_ids" in state:
            param_idx += 1
            set_clauses.append(f"tag_ids = ${param_idx}")
            vals.append(state["tag_ids"])
        if "classes_path" in state:
            param_idx += 1
            set_clauses.append(f"classes_path = ${param_idx}")
            vals.append(state["classes_path"])

        param_idx += 1
        vals.append(self._workspace_id)
        where_clause = f"WHERE id = $1 AND workspace_id = ${param_idx}"

        sql = f"UPDATE node SET {', '.join(set_clauses)} {where_clause}"
        await conn.execute(sql, *vals)
        await self._recompute_class_flags(conn, node_id, class_ids)

    async def _restore_tag_ids(self, conn: asyncpg.Connection, node_id: int, state: dict) -> None:
        """Restore the tag_ids array for a node."""
        await conn.execute(
            """
            UPDATE node
            SET tag_ids = $1, write_date = NOW(), version = version + 1
            WHERE id = $2 AND workspace_id = $3
        """,
            state.get("tag_ids", []),
            node_id,
            self._workspace_id,
        )

    async def _restore_alias(self, conn: asyncpg.Connection, state: dict) -> None:
        """Restore the aliased_id of an alias node."""
        alias_node_id = state.get("alias_node_id")
        if alias_node_id is None:
            return
        await conn.execute(
            """
            UPDATE node
            SET aliased_id = $1, write_date = NOW(), version = version + 1
            WHERE id = $2 AND workspace_id = $3
        """,
            state.get("aliased_id"),
            alias_node_id,
            self._workspace_id,
        )

    async def _restore_property_value(self, conn: asyncpg.Connection, node_id: int, state: dict) -> None:
        """Restore a property value from a snapshot.

        Supports both the legacy format (had_value/value) and the new format
        (had_assignment/values/is_multi/property_type).
        """
        prop_id = state["property_id"]
        prop_type = state.get("property_type", "")

        # Normalize values: new format uses "values" list; legacy uses "value".
        values = state.get("values")
        if values is None:
            single = state.get("value")
            values = [single] if single is not None else []
        if not isinstance(values, list):
            values = [values]

        # Ensure the node_property assignment exists.
        np_row = await conn.fetchrow(
            "SELECT id FROM node_property WHERE node_id = $1 AND property_id = $2",
            node_id,
            prop_id,
        )
        if np_row is None:
            await conn.execute(
                """
                INSERT INTO node_property (uuid, node_id, property_id, create_date, write_date, create_uid, write_uid)
                VALUES (uuid_generate_v4(), $1, $2, NOW(), NOW(), $3, $3)
                ON CONFLICT (node_id, property_id) DO NOTHING
            """,
                node_id,
                prop_id,
                self._user_id,
            )
            np_row = await conn.fetchrow(
                "SELECT id FROM node_property WHERE node_id = $1 AND property_id = $2",
                node_id,
                prop_id,
            )
        node_property_id = np_row["id"] if np_row else None

        if prop_type in ("integer", "float", "boolean", "url", "email"):
            await conn.execute(
                "DELETE FROM property_value_scalar WHERE node_id = $1 AND property_id = $2",
                node_id,
                prop_id,
            )
            for raw in values:
                if raw is None:
                    continue
                value_text = None
                value_integer = None
                value_float = None
                value_boolean = None
                if prop_type in ("url", "email"):
                    value_text = str(raw) if raw is not None else None
                elif prop_type == "integer":
                    value_integer = int(raw) if raw is not None else None
                elif prop_type == "float":
                    value_float = float(raw) if raw is not None else None
                elif prop_type == "boolean":
                    value_boolean = bool(raw) if raw is not None else None
                await conn.execute(
                    """
                    INSERT INTO property_value_scalar
                        (uuid, node_property_id, property_id, node_id, value_text, value_boolean, value_float, value_integer, create_date, write_date, create_uid, write_uid)
                    VALUES (uuid_generate_v4(), $1, $2, $3, $4, $5, $6, $7, NOW(), NOW(), $8, $8)
                """,
                    node_property_id,
                    prop_id,
                    node_id,
                    value_text,
                    value_boolean,
                    value_float,
                    value_integer,
                    self._user_id,
                )
        elif prop_type in ("node", "text", "image", "date"):
            await conn.execute(
                "DELETE FROM property_value_relation WHERE node_id = $1 AND property_id = $2",
                node_id,
                prop_id,
            )
            for target_id in values:
                if target_id is None:
                    continue
                await conn.execute(
                    """
                    INSERT INTO property_value_relation
                        (uuid, node_property_id, property_id, node_id, target_id, create_date, write_date, create_uid, write_uid)
                    VALUES (uuid_generate_v4(), $1, $2, $3, $4, NOW(), NOW(), $5, $5)
                """,
                    node_property_id,
                    prop_id,
                    node_id,
                    target_id,
                    self._user_id,
                )
        elif prop_type == "selection":
            await conn.execute(
                "DELETE FROM property_value_selection WHERE node_id = $1 AND property_id = $2",
                node_id,
                prop_id,
            )
            for line_id in values:
                if line_id is None:
                    continue
                await conn.execute(
                    """
                    INSERT INTO property_value_selection
                        (uuid, node_property_id, property_id, node_id, selection_line_id, create_date, write_date, create_uid, write_uid)
                    VALUES (uuid_generate_v4(), $1, $2, $3, $4, NOW(), NOW(), $5, $5)
                """,
                    node_property_id,
                    prop_id,
                    node_id,
                    line_id,
                    self._user_id,
                )

    async def _delete_property_value(
        self, conn: asyncpg.Connection, node_id: int, prop_id: int, prop_type: str
    ) -> None:
        """Remove a property value and its assignment entirely."""
        if prop_type in ("integer", "float", "boolean", "url", "email"):
            await conn.execute(
                "DELETE FROM property_value_scalar WHERE node_id = $1 AND property_id = $2",
                node_id,
                prop_id,
            )
        elif prop_type in ("node", "text", "image", "date"):
            await conn.execute(
                "DELETE FROM property_value_relation WHERE node_id = $1 AND property_id = $2",
                node_id,
                prop_id,
            )
        elif prop_type == "selection":
            await conn.execute(
                "DELETE FROM property_value_selection WHERE node_id = $1 AND property_id = $2",
                node_id,
                prop_id,
            )
        # Also remove the assignment so the node no longer shows the property.
        await conn.execute(
            "DELETE FROM node_property WHERE node_id = $1 AND property_id = $2",
            node_id,
            prop_id,
        )
