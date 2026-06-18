"""PostgreSQL implementation of TaskCompletionRepository."""

from __future__ import annotations

from datetime import datetime

import asyncpg

from app.db.connection import acquire_connection
from app.domain.entities import TaskCompletion
from app.domain.repositories.base import BasePostgresRepository, normalize_timestamp
from app.features.tasks.port import TaskCompletionRepository
from app.utils import utc_now


class PostgresTaskCompletionRepository(BasePostgresRepository, TaskCompletionRepository):
    """PostgreSQL implementation of the task completion history repository."""

    def _row_to_entity(self, row: asyncpg.Record) -> TaskCompletion:
        """Convert a database row to a TaskCompletion entity."""
        completed_at = row["completed_at"]
        if isinstance(completed_at, datetime):
            completed_at = completed_at.isoformat()
        return TaskCompletion(
            id=row["id"],
            uuid=str(row["uuid"]),
            task_node_id=row["task_node_id"],
            workspace_id=row["workspace_id"],
            scheduled_date=row["scheduled_date"],
            deadline_date=row["deadline_date"],
            status=row["status"],
            completed_at=completed_at,
            completed_by=row.get("completed_by"),
            create_date=normalize_timestamp(row["create_date"]),
        )

    async def list_by_task(
        self, task_node_id: int, limit: int = 50, offset: int = 0
    ) -> list[TaskCompletion]:
        """List completion records for a task node, newest first."""
        async with acquire_connection(self._pool) as conn:
            rows = await conn.fetch(
                """
                SELECT * FROM task_completion
                WHERE task_node_id = $1 AND workspace_id = $2
                ORDER BY completed_at DESC
                LIMIT $3 OFFSET $4
                """,
                task_node_id,
                self._workspace_id,
                limit,
                offset,
            )
            return [self._row_to_entity(row) for row in rows]

    async def create(self, completion: TaskCompletion) -> TaskCompletion:
        """Record a new task completion."""
        now = utc_now()
        if completion.completed_at is None or (
            isinstance(completion.completed_at, str) and not completion.completed_at
        ):
            completion.completed_at = now

        async with acquire_connection(self._pool) as conn:
            row = await conn.fetchrow(
                """
                INSERT INTO task_completion (
                    uuid, task_node_id, workspace_id, scheduled_date, deadline_date,
                    status, completed_at, completed_by, create_date
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
                RETURNING *
                """,
                completion.uuid,
                completion.task_node_id,
                self._workspace_id,
                completion.scheduled_date,
                completion.deadline_date,
                completion.status,
                completion.completed_at,
                completion.completed_by if completion.completed_by is not None else self._user_id,
                now,
            )
            return self._row_to_entity(row)

    async def count_by_task(self, task_node_id: int) -> int:
        """Count total completions for a task node."""
        async with acquire_connection(self._pool) as conn:
            row = await conn.fetchrow(
                """
                SELECT COUNT(*) FROM task_completion
                WHERE task_node_id = $1 AND workspace_id = $2
                """,
                task_node_id,
                self._workspace_id,
            )
            return row["count"] if row else 0

    async def delete(self, completion_id: int) -> bool:
        """Delete a completion record. Returns True if deleted."""
        async with acquire_connection(self._pool) as conn:
            result = await conn.execute(
                """
                DELETE FROM task_completion
                WHERE id = $1 AND workspace_id = $2
                """,
                completion_id,
                self._workspace_id,
            )
            return _deleted_count_from_result(result) > 0


def _deleted_count_from_result(result: str) -> int:
    """Extract the number of deleted rows from an asyncpg DELETE result string."""
    try:
        parts = result.split()
        if len(parts) == 2 and parts[0] == "DELETE":
            return int(parts[1])
    except (ValueError, IndexError):
        pass
    return 0
