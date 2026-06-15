"""Migration: move task_recurrence selection values to the task_recurrence table.

This migration backfills structured recurrence rules from the legacy
``task_recurrence`` selection property. Existing selection values are left in
place so QueryAST filters continue to work; the new table becomes the source of
truth for automation.
"""

from __future__ import annotations

from datetime import UTC, date, datetime
from typing import Any

import asyncpg


def _uuid_to_date(uuid_str: str) -> date | None:
    """Extract a date from a day page UUID.

    Day page UUID format: 00000000-0000-0000-00dd-YYYYMMDD0000
    """
    try:
        parts = uuid_str.split("-")
        date_part = parts[4][:8]
        return date(
            int(date_part[:4]),
            int(date_part[4:6]),
            int(date_part[6:8]),
        )
    except (IndexError, ValueError):
        return None


def _rule_for_option(option_name: str, reference_date: date | None) -> dict[str, Any]:
    """Map a legacy recurrence option name to a structured rule."""
    reference = reference_date or date.today()
    if option_name == "Daily":
        return {"rule_type": "daily", "interval": 1}
    if option_name == "Every Weekday":
        return {"rule_type": "weekday", "interval": 1}
    if option_name == "Weekly":
        return {"rule_type": "weekly", "interval": 1}
    if option_name == "Biweekly":
        return {"rule_type": "weekly", "interval": 2}
    if option_name == "Monthly":
        return {
            "rule_type": "monthly",
            "interval": 1,
            "day_of_month": reference.day,
        }
    if option_name == "Yearly":
        return {
            "rule_type": "yearly",
            "interval": 1,
            "month": reference.month,
            "day_of_month": reference.day,
        }
    # Unknown option: treat as daily to preserve some behavior.
    return {"rule_type": "daily", "interval": 1}


async def run(conn: asyncpg.Connection) -> None:
    """Migrate legacy task_recurrence selection values to task_recurrence rows."""
    from ...db.schema.constants import SYSTEM_PROPERTY_UUIDS
    from ...logging_config import get_logger

    logger = get_logger(__name__)
    recurrence_uuid = SYSTEM_PROPERTY_UUIDS["task_recurrence"]
    scheduled_uuid = SYSTEM_PROPERTY_UUIDS["task_scheduled"]
    deadline_uuid = SYSTEM_PROPERTY_UUIDS["task_deadline"]

    # Ensure the target tables exist on older schemas that may run this migration
    # before the CREATE TABLE statements in SCHEMA_SQL are visible.
    await conn.execute(
        """
        CREATE TABLE IF NOT EXISTS task_recurrence (
            id SERIAL PRIMARY KEY,
            uuid UUID UNIQUE NOT NULL DEFAULT uuid_generate_v4(),
            task_node_id INTEGER NOT NULL REFERENCES node(id) ON DELETE CASCADE,
            workspace_id INTEGER NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
            rule_type VARCHAR(50) NOT NULL,
            interval INTEGER NOT NULL DEFAULT 1,
            weekdays SMALLINT[],
            day_of_month SMALLINT,
            week_of_month SMALLINT,
            month SMALLINT,
            end_after_count INTEGER,
            end_date DATE,
            active BOOLEAN NOT NULL DEFAULT TRUE,
            create_date TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            write_date TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            create_uid INTEGER REFERENCES "user"(id) ON DELETE SET NULL,
            write_uid INTEGER REFERENCES "user"(id) ON DELETE SET NULL,
            UNIQUE(task_node_id)
        )
    """
    )
    await conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_task_recurrence_task_node_id ON task_recurrence(task_node_id)"
    )
    await conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_task_recurrence_workspace_id ON task_recurrence(workspace_id)"
    )

    await conn.execute(
        """
        CREATE TABLE IF NOT EXISTS task_completion (
            id SERIAL PRIMARY KEY,
            uuid UUID UNIQUE NOT NULL DEFAULT uuid_generate_v4(),
            task_node_id INTEGER NOT NULL REFERENCES node(id) ON DELETE CASCADE,
            workspace_id INTEGER NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
            scheduled_date DATE,
            deadline_date DATE,
            status VARCHAR(50) NOT NULL,
            completed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            completed_by INTEGER REFERENCES "user"(id) ON DELETE SET NULL,
            create_date TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
    """
    )
    await conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_task_completion_task_node_id ON task_completion(task_node_id)"
    )
    await conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_task_completion_workspace_id ON task_completion(workspace_id)"
    )

    # Find all workspaces that have the recurrence property and task nodes using it.
    rows = await conn.fetch(
        """
        SELECT
            p.id AS property_id,
            p.workspace_id,
            psl.id AS selection_line_id,
            psl.name AS option_name
        FROM property p
        JOIN property_selection_line psl ON psl.property_id = p.id
        WHERE p.uuid = $1
          AND EXISTS (
              SELECT 1 FROM property_value_selection pvs
              WHERE pvs.property_id = p.id
                AND pvs.selection_line_id = psl.id
          )
    """,
        recurrence_uuid,
    )

    if not rows:
        return

    now = datetime.now(UTC)
    migrated = 0

    for row in rows:
        property_id = row["property_id"]
        workspace_id = row["workspace_id"]
        selection_line_id = row["selection_line_id"]
        option_name = row["option_name"]

        # All nodes using this selection line for recurrence.
        node_rows = await conn.fetch(
            """
            SELECT DISTINCT n.id
            FROM node n
            JOIN property_value_selection pvs
              ON pvs.node_id = n.id AND pvs.property_id = $1
            WHERE pvs.selection_line_id = $2
              AND n.workspace_id = $3
              AND NOT EXISTS (
                  SELECT 1 FROM task_recurrence tr
                  WHERE tr.task_node_id = n.id
              )
        """,
            property_id,
            selection_line_id,
            workspace_id,
        )

        for node_row in node_rows:
            node_id = node_row["id"]

            # Pick a reference date from scheduled/deadline day nodes, or today.
            reference_date: date | None = None
            for date_uuid in (scheduled_uuid, deadline_uuid):
                rel_row = await conn.fetchrow(
                    """
                    SELECT n2.uuid
                    FROM property_value_relation pvr
                    JOIN property p ON p.id = pvr.property_id
                    JOIN node n2 ON n2.id = pvr.target_id
                    WHERE pvr.node_id = $1 AND p.uuid = $2
                    LIMIT 1
                """,
                    node_id,
                    date_uuid,
                )
                if rel_row:
                    parsed = _uuid_to_date(str(rel_row["uuid"]))
                    if parsed:
                        reference_date = parsed
                        break

            rule = _rule_for_option(option_name, reference_date)

            user_row = await conn.fetchrow(
                "SELECT create_uid FROM node WHERE id = $1", node_id
            )
            user_id = user_row["create_uid"] if user_row else None

            await conn.execute(
                """
                INSERT INTO task_recurrence (
                    task_node_id, workspace_id, rule_type, interval,
                    weekdays, day_of_month, week_of_month, month,
                    end_after_count, end_date, active,
                    create_date, write_date, create_uid, write_uid
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, TRUE, $11, $11, $12, $12)
                ON CONFLICT (task_node_id) DO NOTHING
            """,
                node_id,
                workspace_id,
                rule["rule_type"],
                rule.get("interval", 1),
                rule.get("weekdays"),
                rule.get("day_of_month"),
                rule.get("week_of_month"),
                rule.get("month"),
                rule.get("end_after_count"),
                rule.get("end_date"),
                now,
                user_id,
            )
            migrated += 1

    if migrated:
        logger.info(f"Migrated {migrated} task recurrence selection value(s) to task_recurrence table")
