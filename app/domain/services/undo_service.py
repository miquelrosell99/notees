"""Global undo / redo service.

Records reversible operations in the ``undo_log`` table and replays
them on undo or redo requests.  Each entry stores a JSON before- and
after-state snapshot so the service can restore without needing to know
every domain detail — it simply writes the snapshot back.

Supported operations
--------------------
* update_node   — name, icon, color, collapsed changes
* move_node     — parent_id + sequence changes
* delete_node   — soft-delete (is_deleted flag)
* create_node   — records the created node for undo (delete it)
* add_class     — class_ids change
* remove_class  — class_ids change
* set_property  — property value change
* remove_property — property value removal
* archive_node  — active flag change
* unarchive_node — active flag change
"""
from __future__ import annotations

import json
from typing import Any, Optional

import asyncpg

from ...db.connection import acquire_connection
from ...logging_config import get_logger

logger = get_logger(__name__)

# Maximum entries per user per workspace
MAX_UNDO_ENTRIES = 200


class UndoService:
    """Records and replays undo / redo operations."""

    def __init__(self, pool: asyncpg.Pool, workspace_id: int, user_id: int) -> None:
        self._pool = pool
        self._workspace_id = workspace_id
        self._user_id = user_id

    # ------------------------------------------------------------------
    # Recording
    # ------------------------------------------------------------------

    async def record(
        self,
        operation: str,
        entity_type: str,
        entity_id: int,
        before_state: Optional[dict],
        after_state: Optional[dict],
        description: str = "",
    ) -> None:
        """Append an entry to the undo log.

        Also clears any redo entries (entries that were undone) since a new
        action invalidates the redo stack, and trims old entries.
        """
        async with acquire_connection(self._pool) as conn:
            async with conn.transaction():
                # Clear redo stack (any undone entries)
                await conn.execute(
                    "DELETE FROM undo_log WHERE workspace_id = $1 AND user_id = $2 AND is_undone = TRUE",
                    self._workspace_id, self._user_id,
                )

                # Insert new entry
                await conn.execute("""
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
                await conn.execute("""
                    DELETE FROM undo_log
                    WHERE id IN (
                        SELECT id FROM undo_log
                        WHERE workspace_id = $1 AND user_id = $2 AND is_undone = FALSE
                        ORDER BY created_at DESC
                        OFFSET $3
                    )
                """, self._workspace_id, self._user_id, MAX_UNDO_ENTRIES)

    # ------------------------------------------------------------------
    # Undo / Redo
    # ------------------------------------------------------------------

    async def undo(self) -> Optional[dict]:
        """Undo the most recent non-undone operation.

        Returns a dict with ``{operation, entity_type, entity_id, description}``
        on success, or ``None`` if nothing to undo.
        """
        async with acquire_connection(self._pool) as conn:
            row = await conn.fetchrow("""
                SELECT * FROM undo_log
                WHERE workspace_id = $1 AND user_id = $2 AND is_undone = FALSE
                ORDER BY created_at DESC
                LIMIT 1
            """, self._workspace_id, self._user_id)

            if not row:
                return None

            entry = dict(row)
            before_state = json.loads(entry["before_state"]) if entry["before_state"] else None
            after_state = json.loads(entry["after_state"]) if entry["after_state"] else None
            operation = entry["operation"]

            # Apply the reverse — restore before_state
            await self._apply_undo(conn, operation, entry["entity_id"], before_state, after_state)

            # Mark as undone
            await conn.execute(
                "UPDATE undo_log SET is_undone = TRUE WHERE id = $1",
                entry["id"],
            )

        return {
            "operation": operation,
            "entity_type": entry["entity_type"],
            "entity_id": entry["entity_id"],
            "description": entry["description"],
        }

    async def redo(self) -> Optional[dict]:
        """Redo the most recently undone operation.

        Returns a dict with ``{operation, entity_type, entity_id, description}``
        on success, or ``None`` if nothing to redo.
        """
        async with acquire_connection(self._pool) as conn:
            row = await conn.fetchrow("""
                SELECT * FROM undo_log
                WHERE workspace_id = $1 AND user_id = $2 AND is_undone = TRUE
                ORDER BY created_at ASC
                LIMIT 1
            """, self._workspace_id, self._user_id)

            if not row:
                return None

            entry = dict(row)
            before_state = json.loads(entry["before_state"]) if entry["before_state"] else None
            after_state = json.loads(entry["after_state"]) if entry["after_state"] else None
            operation = entry["operation"]

            # Apply the forward — restore after_state
            await self._apply_redo(conn, operation, entry["entity_id"], before_state, after_state)

            # Mark as not-undone
            await conn.execute(
                "UPDATE undo_log SET is_undone = FALSE WHERE id = $1",
                entry["id"],
            )

        return {
            "operation": operation,
            "entity_type": entry["entity_type"],
            "entity_id": entry["entity_id"],
            "description": entry["description"],
        }

    # ------------------------------------------------------------------
    # Stack info
    # ------------------------------------------------------------------

    async def get_stack_info(self) -> dict:
        """Return counts and entry summaries for undo and redo stacks."""
        async with acquire_connection(self._pool) as conn:
            undo_rows = await conn.fetch(
                "SELECT id, operation, entity_type, entity_id, description, created_at "
                "FROM undo_log WHERE workspace_id=$1 AND user_id=$2 AND is_undone=FALSE "
                "ORDER BY created_at DESC LIMIT 50",
                self._workspace_id, self._user_id,
            )
            redo_rows = await conn.fetch(
                "SELECT id, operation, entity_type, entity_id, description, created_at "
                "FROM undo_log WHERE workspace_id=$1 AND user_id=$2 AND is_undone=TRUE "
                "ORDER BY created_at ASC LIMIT 50",
                self._workspace_id, self._user_id,
            )

        def _clean_description(desc: str) -> str:
            """If a stored description contains raw AST JSON, convert to plain text."""
            if not desc:
                return desc
            if desc.startswith('[{"') or desc.startswith('{"'):
                # Likely raw AST — shouldn't happen for new entries but handle old data
                try:
                    from ..stringify_ast import parse_ast, stringify_ast, ParseMode, StringifyMode, StringifyOptions
                    ast = parse_ast(desc, ParseMode.JSON)
                    if ast:
                        return stringify_ast(ast, StringifyOptions(mode=StringifyMode.TEXT_ONLY)) or desc
                except Exception:
                    pass
            return desc

        def _entry(row):
            raw_desc = row["description"] or row["operation"].replace("_", " ").title()
            return {
                "id": row["id"],
                "operation": row["operation"],
                "entity_type": row["entity_type"],
                "entity_id": row["entity_id"],
                "description": _clean_description(raw_desc),
            }

        return {
            "undo_count": len(undo_rows),
            "redo_count": len(redo_rows),
            "undo_entries": [_entry(r) for r in undo_rows],
            "redo_entries": [_entry(r) for r in redo_rows],
        }

    async def undo_to(self, entry_id: int) -> list[dict]:
        """Undo all operations from the top of the stack down to (and including) entry_id.

        Returns a list of undone entry summaries.
        """
        results: list[dict] = []
        async with acquire_connection(self._pool) as conn:
            rows = await conn.fetch(
                "SELECT * FROM undo_log "
                "WHERE workspace_id=$1 AND user_id=$2 AND is_undone=FALSE "
                "ORDER BY created_at DESC",
                self._workspace_id, self._user_id,
            )
            for row in rows:
                entry = dict(row)
                before_state = json.loads(entry["before_state"]) if entry["before_state"] else None
                after_state = json.loads(entry["after_state"]) if entry["after_state"] else None
                await self._apply_undo(conn, entry["operation"], entry["entity_id"], before_state, after_state)
                await conn.execute("UPDATE undo_log SET is_undone = TRUE WHERE id = $1", entry["id"])
                results.append({
                    "operation": entry["operation"],
                    "entity_type": entry["entity_type"],
                    "entity_id": entry["entity_id"],
                    "description": entry["description"],
                })
                if entry["id"] == entry_id:
                    break
        return results

    async def redo_to(self, entry_id: int) -> list[dict]:
        """Redo all operations from the oldest undone up to (and including) entry_id.

        Returns a list of redone entry summaries.
        """
        results: list[dict] = []
        async with acquire_connection(self._pool) as conn:
            rows = await conn.fetch(
                "SELECT * FROM undo_log "
                "WHERE workspace_id=$1 AND user_id=$2 AND is_undone=TRUE "
                "ORDER BY created_at ASC",
                self._workspace_id, self._user_id,
            )
            for row in rows:
                entry = dict(row)
                before_state = json.loads(entry["before_state"]) if entry["before_state"] else None
                after_state = json.loads(entry["after_state"]) if entry["after_state"] else None
                await self._apply_redo(conn, entry["operation"], entry["entity_id"], before_state, after_state)
                await conn.execute("UPDATE undo_log SET is_undone = FALSE WHERE id = $1", entry["id"])
                results.append({
                    "operation": entry["operation"],
                    "entity_type": entry["entity_type"],
                    "entity_id": entry["entity_id"],
                    "description": entry["description"],
                })
                if entry["id"] == entry_id:
                    break
        return results

    async def clear_history(self) -> None:
        """Delete all undo/redo entries for the current user+workspace."""
        async with acquire_connection(self._pool) as conn:
            await conn.execute(
                "DELETE FROM undo_log WHERE workspace_id = $1 AND user_id = $2",
                self._workspace_id, self._user_id,
            )

    # ------------------------------------------------------------------
    # Apply helpers
    # ------------------------------------------------------------------

    async def _apply_undo(
        self,
        conn: asyncpg.Connection,
        operation: str,
        entity_id: int,
        before_state: Optional[dict],
        after_state: Optional[dict],
    ) -> None:
        """Restore ``before_state`` to reverse the operation."""
        if operation == "create_node":
            # Undo create => soft-delete the node
            await conn.execute(
                "UPDATE node SET is_deleted = TRUE, deleted_at = NOW() WHERE id = $1 AND workspace_id = $2",
                entity_id, self._workspace_id,
            )
        elif operation == "delete_node":
            # Undo delete => restore the node (and descendants)
            if before_state:
                deleted_ids = before_state.get("deleted_ids", [entity_id])
                await conn.execute(
                    "UPDATE node SET is_deleted = FALSE, deleted_at = NULL WHERE id = ANY($1::integer[]) AND workspace_id = $2",
                    deleted_ids, self._workspace_id,
                )
        elif operation in ("update_node", "move_node"):
            if before_state:
                await self._restore_node_columns(conn, entity_id, before_state)
        elif operation in ("archive_node", "unarchive_node"):
            if before_state:
                await conn.execute(
                    "UPDATE node SET active = $1, write_date = NOW() WHERE id = $2 AND workspace_id = $3",
                    before_state.get("active", True), entity_id, self._workspace_id,
                )
        elif operation in ("add_class", "remove_class"):
            if before_state:
                await conn.execute(
                    "UPDATE node SET class_ids = $1, write_date = NOW(), version = version + 1 WHERE id = $2 AND workspace_id = $3",
                    before_state["class_ids"], entity_id, self._workspace_id,
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
        elif operation == "remove_property":
            if before_state and before_state.get("had_value"):
                await self._restore_property_value(conn, entity_id, before_state)

    async def _apply_redo(
        self,
        conn: asyncpg.Connection,
        operation: str,
        entity_id: int,
        before_state: Optional[dict],
        after_state: Optional[dict],
    ) -> None:
        """Re-apply ``after_state`` to redo the operation."""
        if operation == "create_node":
            # Redo create => un-delete the node
            await conn.execute(
                "UPDATE node SET is_deleted = FALSE, deleted_at = NULL WHERE id = $1 AND workspace_id = $2",
                entity_id, self._workspace_id,
            )
        elif operation == "delete_node":
            # Redo delete => soft-delete again
            if before_state:
                deleted_ids = before_state.get("deleted_ids", [entity_id])
                await conn.execute(
                    "UPDATE node SET is_deleted = TRUE, deleted_at = NOW() WHERE id = ANY($1::integer[]) AND workspace_id = $2",
                    deleted_ids, self._workspace_id,
                )
        elif operation in ("update_node", "move_node"):
            if after_state:
                await self._restore_node_columns(conn, entity_id, after_state)
        elif operation in ("archive_node", "unarchive_node"):
            if after_state:
                await conn.execute(
                    "UPDATE node SET active = $1, write_date = NOW() WHERE id = $2 AND workspace_id = $3",
                    after_state.get("active", True), entity_id, self._workspace_id,
                )
        elif operation in ("add_class", "remove_class"):
            if after_state:
                await conn.execute(
                    "UPDATE node SET class_ids = $1, write_date = NOW(), version = version + 1 WHERE id = $2 AND workspace_id = $3",
                    after_state["class_ids"], entity_id, self._workspace_id,
                )
                await self._recompute_class_flags(conn, entity_id, after_state["class_ids"])
        elif operation == "set_property":
            if after_state and after_state.get("had_value"):
                await self._restore_property_value(conn, entity_id, after_state)
        elif operation == "remove_property":
            if after_state:
                prop_id = after_state["property_id"]
                await self._delete_property_value(conn, entity_id, prop_id, after_state.get("property_type", ""))

    # ------------------------------------------------------------------
    # Low-level restore
    # ------------------------------------------------------------------

    async def _restore_node_columns(self, conn: asyncpg.Connection, node_id: int, state: dict) -> None:
        """Write back the columns captured in a before/after snapshot."""
        sets = []
        vals = []
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
        from ...db.schema.constants import SYSTEM_CLASS_UUIDS

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
                "SELECT id, uuid FROM node WHERE id = ANY($1::integer[])", class_ids,
            )
            uuid_map = {r["id"]: r["uuid"] for r in rows}
        else:
            uuid_map = {}

        flags = {flag: False for flag in uuid_to_flag.values()}
        for cid in class_ids:
            uuid_val = uuid_map.get(cid)
            if uuid_val and uuid_val in uuid_to_flag:
                flags[uuid_to_flag[uuid_val]] = True

        sets = ", ".join(f"{k} = {'TRUE' if v else 'FALSE'}" for k, v in flags.items())
        await conn.execute(
            f"UPDATE node SET {sets} WHERE id = $1 AND workspace_id = $2",
            node_id, self._workspace_id,
        )

    async def _restore_property_value(self, conn: asyncpg.Connection, node_id: int, state: dict) -> None:
        """Restore a property value from a snapshot."""
        prop_id = state["property_id"]
        prop_type = state.get("property_type", "")
        value = state.get("value")

        if prop_type in ("integer", "float", "boolean"):
            # Scalar
            await conn.execute("""
                INSERT INTO property_value_scalar (node_id, property_id, value, workspace_id)
                VALUES ($1, $2, $3, $4)
                ON CONFLICT (node_id, property_id) DO UPDATE SET value = $3
            """, node_id, prop_id, value, self._workspace_id)
        elif prop_type in ("node", "text", "image", "date"):
            # Relation — value is a target_node_id (or list of them for multi)
            # First remove existing
            await conn.execute(
                "DELETE FROM property_value_relation WHERE node_id = $1 AND property_id = $2 AND workspace_id = $3",
                node_id, prop_id, self._workspace_id,
            )
            if isinstance(value, list):
                for i, v in enumerate(value):
                    await conn.execute("""
                        INSERT INTO property_value_relation (node_id, property_id, target_node_id, sequence, workspace_id)
                        VALUES ($1, $2, $3, $4, $5)
                    """, node_id, prop_id, v, i, self._workspace_id)
            elif value is not None:
                await conn.execute("""
                    INSERT INTO property_value_relation (node_id, property_id, target_node_id, sequence, workspace_id)
                    VALUES ($1, $2, $3, 0, $4)
                """, node_id, prop_id, value, self._workspace_id)
        elif prop_type == "selection":
            await conn.execute(
                "DELETE FROM property_value_selection WHERE node_id = $1 AND property_id = $2 AND workspace_id = $3",
                node_id, prop_id, self._workspace_id,
            )
            if isinstance(value, list):
                for i, v in enumerate(value):
                    await conn.execute("""
                        INSERT INTO property_value_selection (node_id, property_id, selection_line_id, sequence, workspace_id)
                        VALUES ($1, $2, $3, $4, $5)
                    """, node_id, prop_id, v, i, self._workspace_id)
            elif value is not None:
                await conn.execute("""
                    INSERT INTO property_value_selection (node_id, property_id, selection_line_id, sequence, workspace_id)
                    VALUES ($1, $2, $3, 0, $4)
                """, node_id, prop_id, value, self._workspace_id)

    async def _delete_property_value(self, conn: asyncpg.Connection, node_id: int, prop_id: int, prop_type: str) -> None:
        """Remove a property value entirely."""
        if prop_type in ("integer", "float", "boolean"):
            await conn.execute(
                "DELETE FROM property_value_scalar WHERE node_id=$1 AND property_id=$2 AND workspace_id=$3",
                node_id, prop_id, self._workspace_id,
            )
        elif prop_type in ("node", "text", "image", "date"):
            await conn.execute(
                "DELETE FROM property_value_relation WHERE node_id=$1 AND property_id=$2 AND workspace_id=$3",
                node_id, prop_id, self._workspace_id,
            )
        elif prop_type == "selection":
            await conn.execute(
                "DELETE FROM property_value_selection WHERE node_id=$1 AND property_id=$2 AND workspace_id=$3",
                node_id, prop_id, self._workspace_id,
            )
        # Also remove from node_property
        await conn.execute(
            "DELETE FROM node_property WHERE node_id=$1 AND property_id=$2 AND workspace_id=$3",
            node_id, prop_id, self._workspace_id,
        )
