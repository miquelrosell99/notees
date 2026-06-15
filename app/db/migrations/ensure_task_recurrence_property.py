"""Migration: ensure task_recurrence property exists in all workspaces.

This migration was previously embedded in app/db/schema/init.py. It has been
extracted into a standalone migration module so it is tracked and versioned
like the other migrations.
"""

from __future__ import annotations

from datetime import UTC, datetime

import asyncpg

from ..schema.constants import (
    SYSTEM_CLASS_UUIDS,
    SYSTEM_PROPERTY_UUIDS,
    TASK_RECURRENCE_OPTIONS,
)


async def run(conn: asyncpg.Connection) -> None:
    """Ensure the task_recurrence property exists in all workspaces.

    Idempotent migration for existing databases that don't have the recurrence
    property yet.
    """
    from ...logging_config import get_logger

    logger = get_logger(__name__)

    recurrence_uuid = SYSTEM_PROPERTY_UUIDS["task_recurrence"]
    task_uuid = SYSTEM_CLASS_UUIDS["task"]

    workspaces = await conn.fetch(
        """
        SELECT DISTINCT w.workspace_id, w.task_node_id
        FROM (
            SELECT n.workspace_id, n.id AS task_node_id
            FROM node n
            WHERE n.uuid = $1 AND n.active = TRUE
        ) w
        WHERE NOT EXISTS (
            SELECT 1 FROM property p
            WHERE p.workspace_id = w.workspace_id AND p.uuid = $2
        )
    """,
        task_uuid,
        recurrence_uuid,
    )

    if not workspaces:
        return

    now = datetime.now(UTC)

    for ws in workspaces:
        workspace_id = ws["workspace_id"]
        task_class_id = ws["task_node_id"]

        user_row = await conn.fetchrow(
            """
            SELECT create_uid FROM node WHERE workspace_id = $1 AND create_uid IS NOT NULL LIMIT 1
        """,
            workspace_id,
        )
        user_id = user_row["create_uid"] if user_row else 1

        recurrence_row = await conn.fetchrow(
            """
            INSERT INTO property (uuid, workspace_id, name, icon, type, is_multi, is_system, create_date, write_date, create_uid, write_uid)
            VALUES ($1, $2, 'Recurrence', 'repeat', 'selection', FALSE, FALSE, $3, $3, $4, $4)
            ON CONFLICT (workspace_id, uuid) DO UPDATE SET uuid = EXCLUDED.uuid
            RETURNING id
        """,
            recurrence_uuid,
            workspace_id,
            now,
            user_id,
        )

        if recurrence_row:
            recurrence_property_id = recurrence_row["id"]
            for opt in TASK_RECURRENCE_OPTIONS:
                await conn.execute(
                    """
                    INSERT INTO property_selection_line (property_id, name, icon)
                    VALUES ($1, $2, $3)
                """,
                    recurrence_property_id,
                    opt["name"],
                    opt["icon"],
                )

            await conn.execute(
                """
                INSERT INTO class_property (class_node_id, property_id, sequence)
                VALUES ($1, $2, 5)
                ON CONFLICT (class_node_id, property_id) DO NOTHING
            """,
                task_class_id,
                recurrence_property_id,
            )

            logger.info(f"Created task_recurrence property for workspace {workspace_id}")
