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

from app.domain.stringify_ast import ParseMode, StringifyMode, StringifyOptions, parse_ast, stringify_ast
from app.features.undo.port import UndoRepository


class UndoService:
    """Records and replays undo / redo operations.

    This service no longer contains any SQL; it delegates all persistence
    and state-restoration work to an ``UndoRepository`` implementation.
    """

    def __init__(self, undo_repo: UndoRepository) -> None:
        self._undo_repo = undo_repo

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
        """Append an entry to the undo log."""
        await self._undo_repo.record(
            operation,
            entity_type,
            entity_id,
            before_state,
            after_state,
            description,
        )

    # ------------------------------------------------------------------
    # Undo / Redo
    # ------------------------------------------------------------------

    async def undo(self) -> dict | None:
        """Undo the most recent operation."""
        return await self._undo_repo.undo()

    async def redo(self) -> dict | None:
        """Redo the most recently undone operation."""
        return await self._undo_repo.redo()

    # ------------------------------------------------------------------
    # Stack info
    # ------------------------------------------------------------------

    async def get_stack_info(self) -> dict:
        """Return counts and entry summaries for undo and redo stacks."""
        undo_entries = await self._undo_repo.get_undo_entries()
        redo_entries = await self._undo_repo.get_redo_entries()

        return {
            "undo_count": len(undo_entries),
            "redo_count": len(redo_entries),
            "undo_entries": [_summary(e) for e in undo_entries],
            "redo_entries": [_summary(e) for e in redo_entries],
        }

    async def undo_to(self, entry_id: int) -> list[dict]:
        """Undo all operations from the top of the stack down to (and including) entry_id."""
        return await self._undo_repo.undo_to(entry_id)

    async def redo_to(self, entry_id: int) -> list[dict]:
        """Redo all operations from the oldest undone up to (and including) entry_id."""
        return await self._undo_repo.redo_to(entry_id)

    async def clear_history(self) -> None:
        """Delete all undo/redo entries for the current user+workspace."""
        await self._undo_repo.clear()


def _summary(entry: dict) -> dict:
    """Build a client-facing summary for a undo/redo entry."""
    raw_desc = entry.get("description") or entry["operation"].replace("_", " ").title()
    return {
        "id": entry["id"],
        "uuid": entry.get("uuid"),
        "operation": entry["operation"],
        "entity_type": entry["entity_type"],
        "entity_id": entry["entity_id"],
        "description": _clean_description(raw_desc),
    }


def _clean_description(desc: str) -> str:
    """If a stored description contains raw AST JSON, convert to plain text."""
    if not desc:
        return desc
    if desc.startswith('[{"') or desc.startswith('{"'):
        # Likely raw AST — shouldn't happen for new entries but handle old data
        try:
            ast = parse_ast(desc, ParseMode.JSON)
            if ast:
                return stringify_ast(ast, StringifyOptions(mode=StringifyMode.TEXT_ONLY)) or desc
        except (ValueError, TypeError):
            pass
    return desc
