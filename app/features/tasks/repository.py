"""PostgreSQL implementation of TaskRecurrenceRepository."""

from __future__ import annotations

import asyncpg

from app.db.connection import acquire_connection
from app.domain.entities import TaskRecurrence
from app.domain.repositories.base import BasePostgresRepository, normalize_timestamp
from app.features.tasks.port import TaskRecurrenceRepository
from app.utils import utc_now


class PostgresTaskRecurrenceRepository(BasePostgresRepository, TaskRecurrenceRepository):
    """PostgreSQL implementation of the recurrence rule repository."""

    def _row_to_entity(self, row: asyncpg.Record) -> TaskRecurrence:
        """Convert a database row to a TaskRecurrence entity."""
        return TaskRecurrence(
            id=row["id"],
            uuid=str(row["uuid"]),
            task_node_id=row["task_node_id"],
            workspace_id=row["workspace_id"],
            rule_type=row["rule_type"],
            interval=row["interval"],
            weekdays=list(row["weekdays"]) if row["weekdays"] else None,
            day_of_month=row["day_of_month"],
            week_of_month=row["week_of_month"],
            month=row["month"],
            end_after_count=row["end_after_count"],
            end_date=row["end_date"],
            active=row["active"],
            create_date=normalize_timestamp(row["create_date"]),
            write_date=normalize_timestamp(row["write_date"]),
            create_uid=row.get("create_uid"),
            write_uid=row.get("write_uid"),
        )

    async def get_by_task(self, task_node_id: int) -> TaskRecurrence | None:
        """Get the recurrence rule for a task node."""
        async with acquire_connection(self._pool) as conn:
            row = await conn.fetchrow(
                """
                SELECT * FROM task_recurrence
                WHERE task_node_id = $1 AND workspace_id = $2
                """,
                task_node_id,
                self._workspace_id,
            )
            return self._row_to_entity(row) if row else None

    async def upsert(self, data: TaskRecurrence) -> TaskRecurrence:
        """Create or update a recurrence rule for a task node."""
        now = utc_now()
        data.touch(self._user_id)

        async with acquire_connection(self._pool) as conn:
            row = await conn.fetchrow(
                """
                INSERT INTO task_recurrence (
                    uuid, task_node_id, workspace_id, rule_type, interval,
                    weekdays, day_of_month, week_of_month, month,
                    end_after_count, end_date, active,
                    create_date, write_date, create_uid, write_uid
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $13, $14, $14)
                ON CONFLICT (task_node_id) DO UPDATE SET
                    rule_type = EXCLUDED.rule_type,
                    interval = EXCLUDED.interval,
                    weekdays = EXCLUDED.weekdays,
                    day_of_month = EXCLUDED.day_of_month,
                    week_of_month = EXCLUDED.week_of_month,
                    month = EXCLUDED.month,
                    end_after_count = EXCLUDED.end_after_count,
                    end_date = EXCLUDED.end_date,
                    active = EXCLUDED.active,
                    write_date = EXCLUDED.write_date,
                    write_uid = EXCLUDED.write_uid
                RETURNING *
                """,
                data.uuid,
                data.task_node_id,
                self._workspace_id,
                data.rule_type,
                data.interval,
                data.weekdays,
                data.day_of_month,
                data.week_of_month,
                data.month,
                data.end_after_count,
                data.end_date,
                data.active,
                now,
                self._user_id,
            )
            if row is None:
                raise RuntimeError("Failed to upsert task recurrence")
            return self._row_to_entity(row)

    async def delete(self, task_node_id: int) -> bool:
        """Delete the recurrence rule for a task node."""
        async with acquire_connection(self._pool) as conn:
            result = await conn.execute(
                """
                DELETE FROM task_recurrence
                WHERE task_node_id = $1 AND workspace_id = $2
                """,
                task_node_id,
                self._workspace_id,
            )
            return result == "DELETE 1"
