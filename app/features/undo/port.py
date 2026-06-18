"""Repository interfaces (ports) for the undo feature."""

from __future__ import annotations

from abc import ABC, abstractmethod


class UndoRepository(ABC):
    """Repository interface for undo / redo log operations."""

    @abstractmethod
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

        Also clears any redo entries and trims old entries to the configured
        maximum stack size.
        """
        pass

    @abstractmethod
    async def get_undo(self) -> dict | None:
        """Return the most recent non-undone entry, or None if empty."""
        pass

    @abstractmethod
    async def get_redo(self) -> dict | None:
        """Return the most recently undone entry, or None if empty."""
        pass

    @abstractmethod
    async def undo(self) -> dict | None:
        """Undo the most recent operation and mark it undone.

        Returns a summary dict on success, or None if nothing to undo.
        """
        pass

    @abstractmethod
    async def redo(self) -> dict | None:
        """Redo the most recently undone operation and mark it not undone.

        Returns a summary dict on success, or None if nothing to redo.
        """
        pass

    @abstractmethod
    async def get_undo_entries(self) -> list[dict]:
        """Return all non-undone entries ordered newest first."""
        pass

    @abstractmethod
    async def get_redo_entries(self) -> list[dict]:
        """Return all undone entries ordered oldest first."""
        pass

    @abstractmethod
    async def undo_to(self, entry_id: int) -> list[dict]:
        """Undo all operations down to and including entry_id."""
        pass

    @abstractmethod
    async def redo_to(self, entry_id: int) -> list[dict]:
        """Redo all operations up to and including entry_id."""
        pass

    @abstractmethod
    async def clear(self) -> None:
        """Delete all undo/redo entries for the current user+workspace."""
        pass

    @abstractmethod
    async def clear_for_node(self, node_id: int) -> None:
        """Delete all undo/redo entries affecting the given node."""
        pass
