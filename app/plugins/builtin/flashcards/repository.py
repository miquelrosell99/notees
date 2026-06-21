"""PostgreSQL implementation of the flashcard repository port."""

from __future__ import annotations

from datetime import datetime
from typing import Any

from app.db.connection import get_connection

from .port import FlashcardData, FlashcardRepository


class PostgresFlashcardRepository(FlashcardRepository):
    """Flashcard persistence using PostgreSQL."""

    def __init__(self, workspace_id: int) -> None:
        self._workspace_id = workspace_id

    @staticmethod
    def _row_to_data(row: dict[str, Any]) -> FlashcardData:
        return FlashcardData(
            id=row["id"],
            uuid=str(row["uuid"]),
            node_id=row["node_id"],
            workspace_id=row["workspace_id"],
            user_id=row["user_id"],
            front_text=row["front_text"],
            back_text=row["back_text"],
            ease_factor=row["ease_factor"],
            interval_days=row["interval_days"],
            repetitions=row["repetitions"],
            lapses=row["lapses"],
            due_date=row["due_date"],
            last_reviewed_at=row["last_reviewed_at"],
            active=row["active"],
            create_date=row["create_date"],
            write_date=row["write_date"],
        )

    async def create(
        self,
        node_id: int,
        workspace_id: int,
        user_id: int,
        front_text: str,
        back_text: str,
    ) -> FlashcardData:
        conn = get_connection()
        sql = """
            INSERT INTO flashcard (node_id, workspace_id, user_id, front_text, back_text)
            VALUES ($1, $2, $3, $4, $5)
            ON CONFLICT (node_id) DO UPDATE SET
                front_text = EXCLUDED.front_text,
                back_text = EXCLUDED.back_text,
                active = TRUE,
                write_date = NOW()
            RETURNING *
        """
        row = await conn.fetchrow(sql, node_id, workspace_id, user_id, front_text, back_text)
        return self._row_to_data(dict(row))

    async def get_by_node_id(self, node_id: int) -> FlashcardData | None:
        conn = get_connection()
        row = await conn.fetchrow(
            "SELECT * FROM flashcard WHERE node_id = $1",
            node_id,
        )
        if not row:
            return None
        return self._row_to_data(dict(row))

    async def get_due_cards(
        self,
        workspace_id: int,
        user_id: int,
        limit: int = 100,
    ) -> list[FlashcardData]:
        conn = get_connection()
        now = datetime.utcnow()
        rows = await conn.fetch(
            """
            SELECT * FROM flashcard
            WHERE workspace_id = $1 AND user_id = $2 AND active = TRUE
              AND (due_date IS NULL OR due_date <= $3)
            ORDER BY due_date ASC NULLS FIRST, create_date ASC
            LIMIT $4
            """,
            workspace_id,
            user_id,
            now,
            limit,
        )
        return [self._row_to_data(dict(r)) for r in rows]

    async def update_srs(
        self,
        node_id: int,
        ease_factor: float,
        interval_days: int,
        repetitions: int,
        lapses: int,
        due_date: datetime,
        last_reviewed_at: datetime,
    ) -> None:
        conn = get_connection()
        await conn.execute(
            """
            UPDATE flashcard
            SET ease_factor = $1,
                interval_days = $2,
                repetitions = $3,
                lapses = $4,
                due_date = $5,
                last_reviewed_at = $6,
                write_date = NOW()
            WHERE node_id = $7
            """,
            ease_factor,
            interval_days,
            repetitions,
            lapses,
            due_date,
            last_reviewed_at,
            node_id,
        )

    async def delete(self, node_id: int) -> None:
        conn = get_connection()
        await conn.execute("DELETE FROM flashcard WHERE node_id = $1", node_id)

    async def get_stats(self, workspace_id: int, user_id: int) -> dict[str, Any]:
        conn = get_connection()
        now = datetime.utcnow()
        row = await conn.fetchrow(
            """
            SELECT
                COUNT(*) AS total_cards,
                COUNT(*) FILTER (WHERE active = TRUE AND (due_date IS NULL OR due_date <= $1)) AS due_now,
                COUNT(*) FILTER (WHERE repetitions = 0) AS new_cards,
                COUNT(*) FILTER (WHERE repetitions >= 2) AS mature_cards
            FROM flashcard
            WHERE workspace_id = $2 AND user_id = $3
            """,
            now,
            workspace_id,
            user_id,
        )
        return dict(row) if row else {
            "total_cards": 0,
            "due_now": 0,
            "new_cards": 0,
            "mature_cards": 0,
        }
