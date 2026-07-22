"""Storage ports and adapters for the operation relay.

The abstract :class:`RelayStorage` port is intentionally small: save, catch-up
lookup, idempotent existence checks, and maintenance operations for snapshots and
compaction. The SQLite implementation is fully functional for unit tests and
lightweight deployments; the PostgreSQL adapter is the production store.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import sqlite3
import uuid
from abc import ABC, abstractmethod
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import asyncpg

from app.core.clock import Hlc, compare_hlc
from app.db.connection import get_pool
from app.relay.models import EncryptedEnvelope


class RelayStorage(ABC):
    """Abstract port for persisting and retrieving encrypted operation envelopes."""

    @abstractmethod
    def save_envelope(self, envelope: EncryptedEnvelope) -> None:
        """Persist ``envelope``. Callers should dedupe via ``envelope_exists``."""

    @abstractmethod
    def save_envelopes(self, envelopes: list[EncryptedEnvelope]) -> None:
        """Persist many envelopes efficiently."""

    @abstractmethod
    def get_catch_up(self, workspace_id: str, hlc: Hlc) -> list[EncryptedEnvelope]:
        """Return envelopes for ``workspace_id`` with HLC greater than ``hlc``.

        Results are sorted lexicographically by HLC, then by envelope id.
        """

    @abstractmethod
    def get_catch_up_paginated(
        self,
        workspace_id: str,
        hlc: Hlc,
        limit: int = 1000,
        after_id: str | None = None,
    ) -> tuple[list[EncryptedEnvelope], str | None]:
        """Return a page of envelopes newer than ``hlc`` for ``workspace_id``.

        Results are sorted lexicographically by HLC, then by envelope id.
        The returned ``next_after_id`` is the id of the last envelope when the
        page is full, indicating that more results may be available.
        """

    @abstractmethod
    def envelope_exists(self, envelope_id: str) -> bool:
        """Return ``True`` if an envelope with the given id is already stored."""

    @abstractmethod
    def count_operations(self, workspace_id: str) -> int:
        """Return the number of envelopes stored for ``workspace_id``."""

    @abstractmethod
    def get_operation_size_estimate(self, workspace_id: str) -> int:
        """Return the total byte size of encrypted payloads for ``workspace_id``."""

    @abstractmethod
    def get_max_hlc(self, workspace_id: str) -> Hlc:
        """Return the highest envelope HLC for ``workspace_id``.

        Returns:
            The maximum HLC, or ``Hlc(0, 0)`` when no envelopes exist.
        """

    @abstractmethod
    def get_latest_snapshot(self, workspace_id: str) -> dict[str, Any] | None:
        """Return the newest snapshot for ``workspace_id``.

        Returns:
            A dict with ``id``, ``hlc``, and ``data`` keys, or ``None`` when no
            snapshot exists.
        """

    @abstractmethod
    def create_snapshot(
        self, workspace_id: str, up_to_hlc: Hlc, data: bytes = b""
    ) -> str:
        """Create a snapshot covering all envelopes up to ``up_to_hlc``.

        Args:
            data: Optional serialized derived-state payload to store with the
                snapshot.

        Returns:
            The new snapshot id.
        """

    @abstractmethod
    def create_compaction_segment(
        self,
        workspace_id: str,
        up_to_hlc: Hlc,
        prune: bool = True,
        data: bytes = b"",
    ) -> dict[str, Any]:
        """Create a snapshot and record a compacted operation segment.

        Args:
            workspace_id: Workspace to compact.
            up_to_hlc: Highest HLC included in the compaction.
            prune: If ``True``, delete envelopes covered by the segment.
            data: Serialized derived-state payload for the snapshot. Required to
                be non-empty when ``prune`` is ``True``.

        Returns:
            A dict with ``snapshot_id``, ``segment_id``, and ``operation_count``.
        """

    @abstractmethod
    def prune_envelopes(self, workspace_id: str, up_to_hlc: Hlc) -> int:
        """Delete envelopes with HLC less than or equal to ``up_to_hlc``.

        Returns:
            The number of envelopes deleted.
        """

    @abstractmethod
    def get_workspace_stats(self, workspace_id: str) -> dict[str, Any]:
        """Return operational statistics for ``workspace_id``.

        Returns a dict with:
        - envelope_count
        - envelope_size_bytes
        - snapshot_count
        - latest_snapshot_hlc
        - compacted_segment_count
        - compacted_operation_count
        - max_hlc
        """

    @abstractmethod
    def close(self) -> None:
        """Release any resources held by this storage adapter."""


def _hlc_to_dict(hlc: Hlc) -> dict[str, int]:
    return {"physical": hlc.physical, "logical": hlc.logical}


def _dict_to_hlc(d: dict[str, int]) -> Hlc:
    return Hlc(physical=d["physical"], logical=d["logical"])


class SqliteRelayStorage(RelayStorage):
    """In-process SQLite storage for unit tests and lightweight deployments."""

    def __init__(self, db_path: str | Path = ":memory:") -> None:
        self._db_path = str(db_path)
        self._connection = sqlite3.connect(self._db_path, check_same_thread=False)
        self._connection.row_factory = sqlite3.Row
        self._init_schema()

    def _init_schema(self) -> None:
        cursor = self._connection.execute(
            """
            SELECT 1 FROM sqlite_master
            WHERE type = 'table' AND name = 'relay_envelope'
            AND sql LIKE '%ciphertext%'
            """
        )
        needs_migration = cursor.fetchone() is not None
        if needs_migration:
            self._connection.execute("DROP TABLE relay_envelope")

        self._connection.executescript(
            """
            CREATE TABLE IF NOT EXISTS relay_envelope (
                id TEXT PRIMARY KEY,
                workspace_id TEXT NOT NULL,
                actor_id TEXT NOT NULL,
                physical INTEGER NOT NULL,
                logical INTEGER NOT NULL,
                affected_node_ids TEXT NOT NULL DEFAULT '[]',
                op_type TEXT NOT NULL,
                payload TEXT NOT NULL,
                timestamp TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_relay_envelope_workspace_hlc
                ON relay_envelope (workspace_id, physical, logical, id);

            CREATE TABLE IF NOT EXISTS relay_snapshot (
                id TEXT PRIMARY KEY,
                workspace_id TEXT NOT NULL,
                hlc TEXT NOT NULL,
                state_hash TEXT,
                data BLOB,
                created_at TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_relay_snapshot_workspace
                ON relay_snapshot (workspace_id);

            CREATE TABLE IF NOT EXISTS compacted_operation_segment (
                id TEXT PRIMARY KEY,
                workspace_id TEXT NOT NULL,
                from_hlc TEXT NOT NULL,
                to_hlc TEXT NOT NULL,
                snapshot_id TEXT REFERENCES relay_snapshot(id) ON DELETE SET NULL,
                operation_count INTEGER,
                created_at TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_compacted_segment_workspace
                ON compacted_operation_segment (workspace_id);
            """
        )
        self._connection.commit()

    def _row_to_envelope(self, row: sqlite3.Row) -> EncryptedEnvelope:
        timestamp = datetime.fromisoformat(row["timestamp"]) if row["timestamp"] else None
        return EncryptedEnvelope(
            id=row["id"],
            workspace_id=row["workspace_id"],
            actor_id=row["actor_id"],
            hlc={"physical": row["physical"], "logical": row["logical"]},
            affected_node_ids=json.loads(row["affected_node_ids"]),
            op_type=row["op_type"],
            payload=json.loads(row["payload"]),
            timestamp=timestamp,
        )

    def save_envelope(self, envelope: EncryptedEnvelope) -> None:
        self._connection.execute(
            """
            INSERT OR IGNORE INTO relay_envelope (
                id, workspace_id, actor_id, physical, logical,
                affected_node_ids, op_type, payload, timestamp
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                envelope.id,
                envelope.workspace_id,
                envelope.actor_id,
                envelope.hlc.physical,
                envelope.hlc.logical,
                json.dumps(envelope.affected_node_ids),
                envelope.op_type,
                json.dumps(envelope.payload),
                envelope.timestamp.isoformat() if envelope.timestamp else None,
            ),
        )
        self._connection.commit()

    def save_envelopes(self, envelopes: list[EncryptedEnvelope]) -> None:
        """Persist many envelopes in a single transaction.

        This is much faster than calling :meth:`save_envelope` in a loop for
        bulk seeding/migration, where thousands of individual commits would
        otherwise fsync the WAL on every insert.
        """
        rows = [
            (
                envelope.id,
                envelope.workspace_id,
                envelope.actor_id,
                envelope.hlc.physical,
                envelope.hlc.logical,
                json.dumps(envelope.affected_node_ids),
                envelope.op_type,
                json.dumps(envelope.payload),
                envelope.timestamp.isoformat() if envelope.timestamp else None,
            )
            for envelope in envelopes
        ]
        self._connection.executemany(
            """
            INSERT OR IGNORE INTO relay_envelope (
                id, workspace_id, actor_id, physical, logical,
                affected_node_ids, op_type, payload, timestamp
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            rows,
        )
        self._connection.commit()

    def get_catch_up(self, workspace_id: str, hlc: Hlc) -> list[EncryptedEnvelope]:
        cursor = self._connection.execute(
            """
            SELECT * FROM relay_envelope
            WHERE workspace_id = ?
            ORDER BY physical ASC, logical ASC, id ASC
            """,
            (workspace_id,),
        )
        results: list[EncryptedEnvelope] = []
        for row in cursor.fetchall():
            envelope = self._row_to_envelope(row)
            if compare_hlc(envelope.hlc, hlc) > 0:
                results.append(envelope)
        return results

    def get_catch_up_paginated(
        self,
        workspace_id: str,
        hlc: Hlc,
        limit: int = 1000,
        after_id: str | None = None,
    ) -> tuple[list[EncryptedEnvelope], str | None]:
        if after_id is not None:
            cursor_row = self._connection.execute(
                "SELECT physical, logical FROM relay_envelope WHERE id = ?",
                (after_id,),
            ).fetchone()
            if cursor_row is None:
                raise ValueError(
                    f"Pagination cursor envelope {after_id} no longer exists"
                )
            cursor = self._connection.execute(
                """
                SELECT * FROM relay_envelope
                WHERE workspace_id = ?
                  AND (physical, logical) > (?, ?)
                  AND (physical, logical, id) > (?, ?, ?)
                ORDER BY physical ASC, logical ASC, id ASC
                LIMIT ?
                """,
                (
                    workspace_id,
                    hlc.physical,
                    hlc.logical,
                    cursor_row["physical"],
                    cursor_row["logical"],
                    after_id,
                    limit,
                ),
            )
        else:
            cursor = self._connection.execute(
                """
                SELECT * FROM relay_envelope
                WHERE workspace_id = ?
                  AND (physical, logical) > (?, ?)
                ORDER BY physical ASC, logical ASC, id ASC
                LIMIT ?
                """,
                (workspace_id, hlc.physical, hlc.logical, limit),
            )
        results = [self._row_to_envelope(row) for row in cursor.fetchall()]
        next_after_id = results[-1].id if len(results) == limit else None
        return results, next_after_id

    def envelope_exists(self, envelope_id: str) -> bool:
        cursor = self._connection.execute(
            "SELECT 1 FROM relay_envelope WHERE id = ?",
            (envelope_id,),
        )
        return cursor.fetchone() is not None

    def count_operations(self, workspace_id: str) -> int:
        cursor = self._connection.execute(
            "SELECT COUNT(*) FROM relay_envelope WHERE workspace_id = ?",
            (workspace_id,),
        )
        row = cursor.fetchone()
        return row[0] if row else 0

    def get_operation_size_estimate(self, workspace_id: str) -> int:
        cursor = self._connection.execute(
            """
            SELECT COALESCE(SUM(LENGTH(payload)), 0)
            FROM relay_envelope
            WHERE workspace_id = ?
            """,
            (workspace_id,),
        )
        row = cursor.fetchone()
        return row[0] if row else 0

    def get_max_hlc(self, workspace_id: str) -> Hlc:
        cursor = self._connection.execute(
            """
            SELECT physical, logical FROM relay_envelope
            WHERE workspace_id = ?
            ORDER BY physical DESC, logical DESC
            LIMIT 1
            """,
            (workspace_id,),
        )
        row = cursor.fetchone()
        if row is None:
            return Hlc(physical=0, logical=0)
        return Hlc(physical=row["physical"], logical=row["logical"])

    def get_latest_snapshot(self, workspace_id: str) -> dict[str, Any] | None:
        cursor = self._connection.execute(
            """
            SELECT id, hlc, data FROM relay_snapshot
            WHERE workspace_id = ?
              AND data IS NOT NULL
              AND LENGTH(data) > 0
            """,
            (workspace_id,),
        )
        rows = cursor.fetchall()
        if not rows:
            return None

        def _hlc_key(row: sqlite3.Row) -> tuple[int, int]:
            hlc_dict = json.loads(row["hlc"])
            return hlc_dict["physical"], hlc_dict["logical"]

        latest = max(rows, key=_hlc_key)
        hlc_dict = json.loads(latest["hlc"])
        return {
            "id": latest["id"],
            "hlc": _dict_to_hlc(hlc_dict),
            "data": latest["data"] or b"",
        }

    def create_snapshot(
        self, workspace_id: str, up_to_hlc: Hlc, data: bytes = b"", commit: bool = True
    ) -> str:
        if not data:
            cursor = self._connection.execute(
                "SELECT 1 FROM compacted_operation_segment WHERE workspace_id = ? LIMIT 1",
                (workspace_id,),
            )
            if cursor.fetchone() is not None:
                raise ValueError(
                    "Snapshot data must be non-empty when covering pruned operations"
                )
        snapshot_id = str(uuid.uuid4())
        hlc_json = json.dumps(_hlc_to_dict(up_to_hlc))
        state_hash = hashlib.sha256(
            f"{workspace_id}:{hlc_json}:".encode() + data
        ).hexdigest()
        self._connection.execute(
            """
            INSERT INTO relay_snapshot (
                id, workspace_id, hlc, state_hash, data, created_at
            ) VALUES (?, ?, ?, ?, ?, ?)
            """,
            (
                snapshot_id,
                workspace_id,
                hlc_json,
                state_hash,
                data,
                datetime.now(UTC).isoformat(),
            ),
        )
        if commit:
            self._connection.commit()
        return snapshot_id

    def create_compaction_segment(
        self,
        workspace_id: str,
        up_to_hlc: Hlc,
        prune: bool = True,
        data: bytes = b"",
    ) -> dict[str, Any]:
        if prune and not data:
            raise ValueError(
                "Cannot prune operations without non-empty snapshot data"
            )

        hlc_json = json.dumps(_hlc_to_dict(up_to_hlc))
        snapshot_id = self.create_snapshot(
            workspace_id, up_to_hlc, data=data, commit=False
        )
        count = self._connection.execute(
            """
            SELECT COUNT(*) FROM relay_envelope
            WHERE workspace_id = ?
              AND (physical < ? OR (physical = ? AND logical <= ?))
            """,
            (
                workspace_id,
                up_to_hlc.physical,
                up_to_hlc.physical,
                up_to_hlc.logical,
            ),
        ).fetchone()[0]
        segment_id = str(uuid.uuid4())
        self._connection.execute(
            """
            INSERT INTO compacted_operation_segment (
                id, workspace_id, from_hlc, to_hlc, snapshot_id, operation_count, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (
                segment_id,
                workspace_id,
                json.dumps(_hlc_to_dict(Hlc(physical=0, logical=0))),
                hlc_json,
                snapshot_id,
                count,
                datetime.now(UTC).isoformat(),
            ),
        )
        if prune:
            self._connection.execute(
                """
                DELETE FROM relay_envelope
                WHERE workspace_id = ?
                  AND (physical < ? OR (physical = ? AND logical <= ?))
                """,
                (
                    workspace_id,
                    up_to_hlc.physical,
                    up_to_hlc.physical,
                    up_to_hlc.logical,
                ),
            )
        self._connection.commit()
        return {
            "snapshot_id": snapshot_id,
            "segment_id": segment_id,
            "operation_count": count,
        }

    def prune_envelopes(self, workspace_id: str, up_to_hlc: Hlc) -> int:
        cursor = self._connection.execute(
            """
            DELETE FROM relay_envelope
            WHERE workspace_id = ?
              AND (physical < ? OR (physical = ? AND logical <= ?))
            """,
            (
                workspace_id,
                up_to_hlc.physical,
                up_to_hlc.physical,
                up_to_hlc.logical,
            ),
        )
        self._connection.commit()
        return cursor.rowcount

    def get_workspace_stats(self, workspace_id: str) -> dict[str, Any]:
        cursor = self._connection.execute(
            "SELECT COUNT(*), COALESCE(SUM(LENGTH(payload)), 0) FROM relay_envelope WHERE workspace_id = ?",
            (workspace_id,),
        )
        envelope_count, envelope_size = cursor.fetchone()

        cursor = self._connection.execute(
            "SELECT COUNT(*) FROM relay_snapshot WHERE workspace_id = ?",
            (workspace_id,),
        )
        snapshot_count = cursor.fetchone()[0]

        cursor = self._connection.execute(
            """
            SELECT hlc FROM relay_snapshot
            WHERE workspace_id = ? AND data IS NOT NULL AND LENGTH(data) > 0
            ORDER BY hlc DESC LIMIT 1
            """,
            (workspace_id,),
        )
        snapshot_row = cursor.fetchone()
        latest_snapshot_hlc = (
            _dict_to_hlc(json.loads(snapshot_row["hlc"])) if snapshot_row else None
        )

        cursor = self._connection.execute(
            """
            SELECT COUNT(*), COALESCE(SUM(operation_count), 0)
            FROM compacted_operation_segment
            WHERE workspace_id = ?
            """,
            (workspace_id,),
        )
        compacted_segment_count, compacted_operation_count = cursor.fetchone()

        cursor = self._connection.execute(
            """
            SELECT physical, logical FROM relay_envelope
            WHERE workspace_id = ?
            ORDER BY physical DESC, logical DESC LIMIT 1
            """,
            (workspace_id,),
        )
        max_row = cursor.fetchone()
        max_hlc = (
            Hlc(physical=max_row["physical"], logical=max_row["logical"])
            if max_row
            else Hlc(physical=0, logical=0)
        )

        return {
            "envelope_count": envelope_count,
            "envelope_size_bytes": envelope_size,
            "snapshot_count": snapshot_count,
            "latest_snapshot_hlc": latest_snapshot_hlc,
            "compacted_segment_count": compacted_segment_count,
            "compacted_operation_count": compacted_operation_count,
            "max_hlc": max_hlc,
        }

    def close(self) -> None:
        """Close the underlying SQLite connection."""
        self._connection.close()


class PostgresRelayStorage(RelayStorage):
    """Production PostgreSQL storage adapter using asyncpg."""

    def __init__(self, pool: Any | None = None) -> None:
        self._pool = pool
        self._pool_lock = asyncio.Lock()

    async def _get_pool(self) -> Any:
        if self._pool is None:
            async with self._pool_lock:
                if self._pool is None:
                    self._pool = await get_pool()
        return self._pool

    @staticmethod
    def _row_to_envelope(row: asyncpg.Record) -> EncryptedEnvelope:
        return EncryptedEnvelope(
            id=row["id"],
            workspace_id=row["workspace_id"],
            actor_id=row["actor_id"],
            hlc={"physical": row["physical"], "logical": row["logical"]},
            affected_node_ids=row["affected_node_ids"],
            op_type=row["op_type"],
            payload=row["payload"],
            timestamp=row["timestamp"],
        )

    async def save_envelope(self, envelope: EncryptedEnvelope) -> None:
        pool = await self._get_pool()
        await pool.execute(
            """
            INSERT INTO relay_envelope (
                id, workspace_id, actor_id, physical, logical,
                affected_node_ids, op_type, payload, timestamp
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
            ON CONFLICT (id) DO NOTHING
            """,
            envelope.id,
            envelope.workspace_id,
            envelope.actor_id,
            envelope.hlc.physical,
            envelope.hlc.logical,
            envelope.affected_node_ids,
            envelope.op_type,
            envelope.payload,
            envelope.timestamp,
        )

    async def save_envelopes(self, envelopes: list[EncryptedEnvelope]) -> None:
        pool = await self._get_pool()
        rows = [
            (
                envelope.id,
                envelope.workspace_id,
                envelope.actor_id,
                envelope.hlc.physical,
                envelope.hlc.logical,
                envelope.affected_node_ids,
                envelope.op_type,
                envelope.payload,
                envelope.timestamp,
            )
            for envelope in envelopes
        ]
        async with pool.acquire() as conn:
            await conn.executemany(
                """
                INSERT INTO relay_envelope (
                    id, workspace_id, actor_id, physical, logical,
                    affected_node_ids, op_type, payload, timestamp
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
                ON CONFLICT (id) DO NOTHING
                """,
                rows,
            )

    async def get_catch_up(self, workspace_id: str, hlc: Hlc) -> list[EncryptedEnvelope]:
        pool = await self._get_pool()
        rows = await pool.fetch(
            """
            SELECT * FROM relay_envelope
            WHERE workspace_id = $1
              AND (physical, logical) > ($2, $3)
            ORDER BY physical ASC, logical ASC, id ASC
            """,
            workspace_id,
            hlc.physical,
            hlc.logical,
        )
        return [self._row_to_envelope(row) for row in rows]

    async def get_catch_up_paginated(
        self,
        workspace_id: str,
        hlc: Hlc,
        limit: int = 1000,
        after_id: str | None = None,
    ) -> tuple[list[EncryptedEnvelope], str | None]:
        pool = await self._get_pool()
        if after_id is not None:
            cursor_row = await pool.fetchrow(
                "SELECT physical, logical, id FROM relay_envelope WHERE id = $1::text",
                after_id,
            )
            if cursor_row is None:
                raise ValueError(
                    f"Pagination cursor envelope {after_id} no longer exists"
                )
            rows = await pool.fetch(
                """
                SELECT * FROM relay_envelope
                WHERE workspace_id = $1
                  AND (physical, logical) > ($2, $3)
                  AND (physical, logical, id) > ($4, $5, $6)
                ORDER BY physical ASC, logical ASC, id ASC
                LIMIT $7
                """,
                workspace_id,
                hlc.physical,
                hlc.logical,
                cursor_row["physical"],
                cursor_row["logical"],
                after_id,
                limit,
            )
        else:
            rows = await pool.fetch(
                """
                SELECT * FROM relay_envelope
                WHERE workspace_id = $1
                  AND (physical, logical) > ($2, $3)
                ORDER BY physical ASC, logical ASC, id ASC
                LIMIT $4
                """,
                workspace_id,
                hlc.physical,
                hlc.logical,
                limit,
            )
        results = [self._row_to_envelope(row) for row in rows]
        next_after_id = results[-1].id if len(results) == limit else None
        return results, next_after_id

    async def envelope_exists(self, envelope_id: str) -> bool:
        pool = await self._get_pool()
        row = await pool.fetchrow(
            "SELECT 1 FROM relay_envelope WHERE id = $1",
            envelope_id,
        )
        return row is not None

    async def count_operations(self, workspace_id: str) -> int:
        pool = await self._get_pool()
        row = await pool.fetchrow(
            "SELECT COUNT(*) FROM relay_envelope WHERE workspace_id = $1",
            workspace_id,
        )
        return row[0] if row else 0

    async def get_operation_size_estimate(self, workspace_id: str) -> int:
        pool = await self._get_pool()
        row = await pool.fetchrow(
            """
            SELECT COALESCE(SUM(LENGTH(payload::text)), 0)
            FROM relay_envelope
            WHERE workspace_id = $1
            """,
            workspace_id,
        )
        return row[0] if row else 0

    async def get_max_hlc(self, workspace_id: str) -> Hlc:
        pool = await self._get_pool()
        row = await pool.fetchrow(
            """
            SELECT physical, logical FROM relay_envelope
            WHERE workspace_id = $1
            ORDER BY physical DESC, logical DESC
            LIMIT 1
            """,
            workspace_id,
        )
        if row is None:
            return Hlc(physical=0, logical=0)
        return Hlc(physical=row["physical"], logical=row["logical"])

    async def get_latest_snapshot(self, workspace_id: str) -> dict[str, Any] | None:
        pool = await self._get_pool()
        row = await pool.fetchrow(
            """
            SELECT id, hlc, data FROM relay_snapshot
            WHERE workspace_id = $1
              AND data IS NOT NULL
              AND OCTET_LENGTH(data) > 0
            ORDER BY (hlc->>'physical')::bigint DESC, (hlc->>'logical')::bigint DESC
            LIMIT 1
            """,
            workspace_id,
        )
        if row is None:
            return None
        hlc_dict = row["hlc"]
        return {
            "id": str(row["id"]),
            "hlc": _dict_to_hlc(hlc_dict),
            "data": row["data"] or b"",
        }

    async def create_snapshot(
        self, workspace_id: str, up_to_hlc: Hlc, data: bytes = b"", conn: Any | None = None
    ) -> str:
        if not data:
            executor = conn if conn is not None else (await self._get_pool())
            segment_count = await executor.fetchval(
                "SELECT COUNT(*) FROM compacted_operation_segment WHERE workspace_id = $1",
                workspace_id,
            )
            if segment_count:
                raise ValueError(
                    "Snapshot data must be non-empty when covering pruned operations"
                )
        hlc_dict = _hlc_to_dict(up_to_hlc)
        state_hash = hashlib.sha256(
            f"{workspace_id}:{json.dumps(hlc_dict)}:".encode() + data
        ).hexdigest()
        executor = conn if conn is not None else (await self._get_pool())
        row = await executor.fetchrow(
            """
            INSERT INTO relay_snapshot (workspace_id, hlc, state_hash, data)
            VALUES ($1, $2, $3, $4)
            RETURNING id
            """,
            workspace_id,
            hlc_dict,
            state_hash,
            data,
        )
        return str(row["id"])

    async def create_compaction_segment(
        self,
        workspace_id: str,
        up_to_hlc: Hlc,
        prune: bool = True,
        data: bytes = b"",
    ) -> dict[str, Any]:
        if prune and not data:
            raise ValueError(
                "Cannot prune operations without non-empty snapshot data"
            )

        pool = await self._get_pool()
        async with pool.acquire() as conn, conn.transaction():
            snapshot_id = await self.create_snapshot(
                workspace_id, up_to_hlc, data=data, conn=conn
            )
            count_row = await conn.fetchrow(
                """
                SELECT COUNT(*) FROM relay_envelope
                WHERE workspace_id = $1
                  AND (physical, logical) <= ($2, $3)
                """,
                workspace_id,
                up_to_hlc.physical,
                up_to_hlc.logical,
            )
            count = count_row[0] if count_row else 0
            segment_row = await conn.fetchrow(
                """
                INSERT INTO compacted_operation_segment (
                    workspace_id, from_hlc, to_hlc, snapshot_id, operation_count
                ) VALUES ($1, $2, $3, $4, $5)
                RETURNING id
                """,
                workspace_id,
                _hlc_to_dict(Hlc(physical=0, logical=0)),
                _hlc_to_dict(up_to_hlc),
                snapshot_id,
                count,
            )
            segment_id = str(segment_row["id"])
            if prune:
                await conn.execute(
                    """
                    DELETE FROM relay_envelope
                    WHERE workspace_id = $1
                      AND (physical, logical) <= ($2, $3)
                    """,
                    workspace_id,
                    up_to_hlc.physical,
                    up_to_hlc.logical,
                )
        return {
            "snapshot_id": snapshot_id,
            "segment_id": segment_id,
            "operation_count": count,
        }

    async def prune_envelopes(self, workspace_id: str, up_to_hlc: Hlc) -> int:
        pool = await self._get_pool()
        result = await pool.execute(
            """
            DELETE FROM relay_envelope
            WHERE workspace_id = $1
              AND (physical, logical) <= ($2, $3)
            """,
            workspace_id,
            up_to_hlc.physical,
            up_to_hlc.logical,
        )
        # asyncpg DELETE returns "DELETE N"
        parts = result.split()
        return int(parts[-1]) if parts else 0

    async def get_workspace_stats(self, workspace_id: str) -> dict[str, Any]:
        pool = await self._get_pool()
        envelope_row = await pool.fetchrow(
            """
            SELECT COUNT(*) AS count, COALESCE(SUM(LENGTH(payload::text)), 0) AS size
            FROM relay_envelope
            WHERE workspace_id = $1
            """,
            workspace_id,
        )
        snapshot_count_row = await pool.fetchrow(
            "SELECT COUNT(*) AS count FROM relay_snapshot WHERE workspace_id = $1",
            workspace_id,
        )
        latest_snapshot_row = await pool.fetchrow(
            """
            SELECT hlc FROM relay_snapshot
            WHERE workspace_id = $1 AND data IS NOT NULL AND OCTET_LENGTH(data) > 0
            ORDER BY (hlc->>'physical')::bigint DESC, (hlc->>'logical')::bigint DESC
            LIMIT 1
            """,
            workspace_id,
        )
        latest_snapshot_hlc = (
            _dict_to_hlc(latest_snapshot_row["hlc"]) if latest_snapshot_row else None
        )
        compacted_row = await pool.fetchrow(
            """
            SELECT COUNT(*) AS count, COALESCE(SUM(operation_count), 0) AS ops
            FROM compacted_operation_segment
            WHERE workspace_id = $1
            """,
            workspace_id,
        )
        max_row = await pool.fetchrow(
            """
            SELECT physical, logical FROM relay_envelope
            WHERE workspace_id = $1
            ORDER BY physical DESC, logical DESC LIMIT 1
            """,
            workspace_id,
        )
        max_hlc = (
            Hlc(physical=max_row["physical"], logical=max_row["logical"])
            if max_row
            else Hlc(physical=0, logical=0)
        )
        return {
            "envelope_count": envelope_row["count"] if envelope_row else 0,
            "envelope_size_bytes": envelope_row["size"] if envelope_row else 0,
            "snapshot_count": snapshot_count_row["count"] if snapshot_count_row else 0,
            "latest_snapshot_hlc": latest_snapshot_hlc,
            "compacted_segment_count": compacted_row["count"] if compacted_row else 0,
            "compacted_operation_count": compacted_row["ops"] if compacted_row else 0,
            "max_hlc": max_hlc,
        }

    async def close(self) -> None:
        """No persistent per-instance connection; drop the cached pool reference."""
        self._pool = None
