"""Repository interfaces (ports) for the tasks feature."""

from __future__ import annotations

from abc import ABC, abstractmethod
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from app.domain.entities import TaskCompletion, TaskRecurrence


class TaskRecurrenceRepository(ABC):
    """Repository interface for task recurrence rules."""

    @abstractmethod
    async def get_by_task(self, task_node_id: int) -> TaskRecurrence | None:
        """Get the recurrence rule for a task node."""
        pass

    @abstractmethod
    async def upsert(self, data: TaskRecurrence) -> TaskRecurrence:
        """Create or update a recurrence rule for a task node."""
        pass

    @abstractmethod
    async def delete(self, task_node_id: int) -> bool:
        """Delete the recurrence rule for a task node. Returns True if deleted."""
        pass

class TaskCompletionRepository(ABC):
    """Repository interface for task completion history."""

    @abstractmethod
    async def list_by_task(
        self, task_node_id: int, limit: int = 50, offset: int = 0
    ) -> list[TaskCompletion]:
        """List completion records for a task node, newest first."""
        pass

    @abstractmethod
    async def create(self, completion: TaskCompletion) -> TaskCompletion:
        """Record a new task completion."""
        pass

    @abstractmethod
    async def count_by_task(self, task_node_id: int) -> int:
        """Count total completions for a task node."""
        pass

    @abstractmethod
    async def delete(self, completion_id: int) -> bool:
        """Delete a completion record. Returns True if deleted."""
        pass
