"""WorkspaceStore implementation of the flashcard repository port."""

from __future__ import annotations

import sqlite3
from datetime import UTC, datetime
from typing import Any

from app.core.workspace_store import WorkspaceStore

from .port import FlashcardData, FlashcardRepository


class WorkspaceStoreFlashcardRepository(FlashcardRepository):
    """Flashcard persistence using operation-log derived state."""

    def __init__(self, store: WorkspaceStore, workspace_id: int, user_id: int) -> None:
        super().__init__(store, workspace_id, user_id)

    @staticmethod
    def _parse_datetime(value: Any) -> datetime | None:
        if value is None:
            return None
        if isinstance(value, datetime):
            return value
        # SQLite stores datetimes as ISO strings.
        return datetime.fromisoformat(value)

    def _row_to_data(self, row: dict[str, Any]) -> FlashcardData:
        return FlashcardData(
            id=row["id"],
            uuid=row["uuid"],
            node_uuid=row["node_id"],
            workspace_id=self._workspace_id,
            user_id=self._user_id,
            front_text=row["front_text"],
            back_text=row["back_text"],
            ease_factor=row["ease_factor"],
            interval_days=row["interval_days"],
            repetitions=row["repetitions"],
            lapses=row["lapses"],
            due_date=self._parse_datetime(row["due_date"]),
            last_reviewed_at=self._parse_datetime(row["last_reviewed_at"]),
            active=bool(row["active"]),
            create_date=self._parse_datetime(row["created_at"]),
            write_date=self._parse_datetime(row["updated_at"]),
        )

    async def _fetch_row(self, node_uuid: str) -> sqlite3.Row | None:
        rows = await self._store.query(
            """
            SELECT * FROM flashcard
            WHERE node_id = ? AND workspace_id = ? AND actor_id = ?
            """,
            (node_uuid, self._store.workspace_id, self._store.actor_id),
        )
        return rows[0] if rows else None

    async def create(
        self,
        node_uuid: str,
        front_text: str,
        back_text: str,
    ) -> FlashcardData:
        await self._store.plugin_op(
            plugin_id="notees.flashcards",
            op_type="flashcard.create",
            data={
                "workspaceId": self._store.workspace_id,
                "actorId": self._store.actor_id,
                "frontText": front_text,
                "backText": back_text,
            },
            node_id=node_uuid,
        )
        row = await self._fetch_row(node_uuid)
        if row is None:
            raise RuntimeError("Flashcard row not found after create")
        return self._row_to_data(dict(row))

    async def get_by_node_uuid(self, node_uuid: str) -> FlashcardData | None:
        row = await self._fetch_row(node_uuid)
        if not row:
            return None
        return self._row_to_data(dict(row))

    async def get_due_cards(self, limit: int = 100) -> list[FlashcardData]:
        now = datetime.now(UTC).isoformat()
        rows = await self._store.query(
            """
            SELECT * FROM flashcard
            WHERE workspace_id = ? AND actor_id = ? AND active = 1
              AND (due_date IS NULL OR due_date <= ?)
            ORDER BY due_date ASC NULLS FIRST, created_at ASC
            LIMIT ?
            """,
            (self._store.workspace_id, self._store.actor_id, now, limit),
        )
        return [self._row_to_data(dict(r)) for r in rows]

    async def update_srs(
        self,
        node_uuid: str,
        ease_factor: float,
        interval_days: int,
        repetitions: int,
        lapses: int,
        due_date: datetime,
        last_reviewed_at: datetime,
    ) -> None:
        await self._store.plugin_op(
            plugin_id="notees.flashcards",
            op_type="flashcard.review",
            data={
                "easeFactor": ease_factor,
                "intervalDays": interval_days,
                "repetitions": repetitions,
                "lapses": lapses,
                "dueDate": due_date.isoformat() if due_date else None,
                "lastReviewedAt": last_reviewed_at.isoformat() if last_reviewed_at else None,
            },
            node_id=node_uuid,
        )

    async def delete(self, node_uuid: str) -> None:
        await self._store.plugin_op(
            plugin_id="notees.flashcards",
            op_type="flashcard.delete",
            data={},
            node_id=node_uuid,
        )

    async def get_stats(self) -> dict[str, Any]:
        now = datetime.now(UTC).isoformat()
        rows = await self._store.query(
            """
            SELECT
                COUNT(*) AS total_cards,
                SUM(CASE WHEN active = 1 AND (due_date IS NULL OR due_date <= ?) THEN 1 ELSE 0 END) AS due_now,
                SUM(CASE WHEN repetitions = 0 THEN 1 ELSE 0 END) AS new_cards,
                SUM(CASE WHEN repetitions >= 2 THEN 1 ELSE 0 END) AS mature_cards
            FROM flashcard
            WHERE workspace_id = ? AND actor_id = ?
            """,
            (now, self._store.workspace_id, self._store.actor_id),
        )
        if not rows:
            return {
                "total_cards": 0,
                "due_now": 0,
                "new_cards": 0,
                "mature_cards": 0,
            }
        row = rows[0]
        return {
            "total_cards": row["total_cards"] or 0,
            "due_now": row["due_now"] or 0,
            "new_cards": row["new_cards"] or 0,
            "mature_cards": row["mature_cards"] or 0,
        }
