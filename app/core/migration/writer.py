"""SQLite target store for migrated operations.

The schema mirrors the client ``operation`` table from the ideal architecture.
Payloads are stored as unencrypted JSON bytes during migration; encryption is
applied later when operations are imported into a workspace.
"""

from __future__ import annotations

import json
import sqlite3
from abc import ABC, abstractmethod
from pathlib import Path
from typing import Any

from app.core.operation import Operation

OPERATION_TABLE_SQL = """
CREATE TABLE IF NOT EXISTS operation (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    actor_id TEXT NOT NULL,
    hlc_physical INTEGER NOT NULL,
    hlc_logical INTEGER NOT NULL,
    affected_node_ids TEXT NOT NULL,
    op_type TEXT NOT NULL,
    payload BLOB NOT NULL,
    timestamp TEXT
);

CREATE INDEX IF NOT EXISTS idx_operation_workspace
    ON operation(workspace_id);
CREATE INDEX IF NOT EXISTS idx_operation_hlc
    ON operation(hlc_physical, hlc_logical);
"""


class OperationWriter(ABC):
    """Abstract sink for ``Operation`` objects."""

    @abstractmethod
    def write_operation(self, operation: Operation) -> None:
        """Persist ``operation``."""

    @abstractmethod
    def close(self) -> None:
        """Release any resources held by the writer."""


class SqliteOperationWriter(OperationWriter):
    """Write operations to a SQLite file."""

    def __init__(self, path: str | Path) -> None:
        self._path = Path(path)
        self._path.parent.mkdir(parents=True, exist_ok=True)
        self._conn = sqlite3.connect(str(self._path))
        self._ensure_schema()

    def _ensure_schema(self) -> None:
        self._conn.executescript(OPERATION_TABLE_SQL)
        self._conn.commit()

    def write_operation(self, operation: Operation) -> None:
        env = operation.envelope
        hlc = env.hlc
        self._conn.execute(
            """
            INSERT INTO operation (
                id, workspace_id, actor_id, hlc_physical, hlc_logical,
                affected_node_ids, op_type, payload, timestamp
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                env.id,
                env.workspace_id,
                env.actor_id,
                hlc.physical,
                hlc.logical,
                json.dumps(env.affected_node_ids),
                env.op_type,
                json.dumps(operation.payload).encode("utf-8"),
                env.timestamp.isoformat() if env.timestamp else None,
            ),
        )
        self._conn.commit()

    def close(self) -> None:
        self._conn.close()

    def count(self) -> int:
        """Return the number of operations currently stored."""
        row = self._conn.execute("SELECT COUNT(*) FROM operation").fetchone()
        return row[0] if row else 0


class InMemoryOperationWriter(OperationWriter):
    """Collect operations in memory for dry runs and unit tests."""

    def __init__(self) -> None:
        self.operations: list[Operation] = []

    def write_operation(self, operation: Operation) -> None:
        self.operations.append(operation)

    def close(self) -> None:
        pass

    def count(self) -> int:
        return len(self.operations)

    def payload(self, index: int) -> dict[str, Any]:
        """Return the payload of the operation at ``index``."""
        return self.operations[index].payload

    def envelope(self, index: int) -> Any:
        """Return the envelope of the operation at ``index``."""
        return self.operations[index].envelope
