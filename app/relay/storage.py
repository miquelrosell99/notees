"""Storage ports and adapters for the operation relay.

The abstract :class:`RelayStorage` port is intentionally small: save, catch-up
lookup, and idempotent existence checks. The SQLite implementation is fully
functional for unit tests; the PostgreSQL adapter is a stub for Phase 5.
"""

from __future__ import annotations

import json
import sqlite3
from abc import ABC, abstractmethod
from datetime import datetime
from pathlib import Path

from app.core.clock import Hlc, compare_hlc
from app.relay.models import EncryptedEnvelope


class RelayStorage(ABC):
    """Abstract port for persisting and retrieving encrypted operation envelopes."""

    @abstractmethod
    def save_envelope(self, envelope: EncryptedEnvelope) -> None:
        """Persist ``envelope``. Callers should dedupe via ``envelope_exists``."""

    @abstractmethod
    def get_catch_up(self, workspace_id: str, hlc: Hlc) -> list[EncryptedEnvelope]:
        """Return envelopes for ``workspace_id`` with HLC greater than ``hlc``.

        Results are sorted lexicographically by HLC, then by envelope id.
        """

    @abstractmethod
    def envelope_exists(self, envelope_id: str) -> bool:
        """Return ``True`` if an envelope with the given id is already stored."""

    @abstractmethod
    def close(self) -> None:
        """Release any resources held by this storage adapter."""


class SqliteRelayStorage(RelayStorage):
    """In-process SQLite storage for unit tests and lightweight deployments."""

    def __init__(self, db_path: str | Path = ":memory:") -> None:
        self._db_path = str(db_path)
        self._connection = sqlite3.connect(self._db_path, check_same_thread=False)
        self._connection.row_factory = sqlite3.Row
        self._init_schema()

    def _init_schema(self) -> None:
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
                ciphertext TEXT NOT NULL,
                iv TEXT NOT NULL,
                timestamp TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_relay_envelope_workspace_hlc
                ON relay_envelope (workspace_id, physical, logical, id);
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
            ciphertext=row["ciphertext"],
            iv=row["iv"],
            timestamp=timestamp,
        )

    def save_envelope(self, envelope: EncryptedEnvelope) -> None:
        self._connection.execute(
            """
            INSERT OR IGNORE INTO relay_envelope (
                id, workspace_id, actor_id, physical, logical,
                affected_node_ids, op_type, ciphertext, iv, timestamp
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                envelope.id,
                envelope.workspace_id,
                envelope.actor_id,
                envelope.hlc.physical,
                envelope.hlc.logical,
                json.dumps(envelope.affected_node_ids),
                envelope.op_type,
                envelope.ciphertext,
                envelope.iv,
                envelope.timestamp.isoformat() if envelope.timestamp else None,
            ),
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

    def envelope_exists(self, envelope_id: str) -> bool:
        cursor = self._connection.execute(
            "SELECT 1 FROM relay_envelope WHERE id = ?",
            (envelope_id,),
        )
        return cursor.fetchone() is not None

    def close(self) -> None:
        """Close the underlying SQLite connection."""
        self._connection.close()


class PostgresRelayStorage(RelayStorage):
    """Production PostgreSQL storage adapter (stub for Phase 5).

    The real implementation will use asyncpg, store HLCs as JSONB, and rely on
    the server schema defined in the ideal architecture specification.
    """

    def save_envelope(self, envelope: EncryptedEnvelope) -> None:
        """TODO: Persist ``envelope`` to PostgreSQL in Phase 5."""
        raise NotImplementedError("PostgresRelayStorage.save_envelope is a stub for Phase 5")

    def get_catch_up(self, workspace_id: str, hlc: Hlc) -> list[EncryptedEnvelope]:
        """TODO: Query catch-up envelopes from PostgreSQL in Phase 5."""
        raise NotImplementedError("PostgresRelayStorage.get_catch_up is a stub for Phase 5")

    def envelope_exists(self, envelope_id: str) -> bool:
        """TODO: Check existence against PostgreSQL in Phase 5."""
        raise NotImplementedError("PostgresRelayStorage.envelope_exists is a stub for Phase 5")

    def close(self) -> None:
        """TODO: Close PostgreSQL resources in Phase 5."""
        raise NotImplementedError("PostgresRelayStorage.close is a stub for Phase 5")
