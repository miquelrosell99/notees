"""PostgreSQL relay target store for migrated operations.

Writes operations directly into the production ``relay_envelope`` table so the
migration can be replayed by real workspace clients. The writer is intentionally
synchronous at the surface (it implements :class:`OperationWriter`) because the
migration modules emit operations synchronously, but it buffers rows and
requires an explicit async flush from the async migration script.
"""

from __future__ import annotations

import asyncpg

from app.core.migration.writer import OperationWriter
from app.core.operation import Operation
from app.relay.models import RelayEnvelope


class PostgresOperationWriter(OperationWriter):
    """Buffer operations and flush them into ``relay_envelope`` in bulk.

    Args:
        conn: Asyncpg connection to the target PostgreSQL database.
        batch_size: Maximum number of envelopes to keep in memory before an
            automatic flush is triggered inside :meth:`write_operation`.
            Automatic flushes are synchronous and therefore disabled by default;
            callers should await :meth:`flush` at safe async boundaries.
    """

    def __init__(self, conn: asyncpg.Connection, batch_size: int = 1000) -> None:
        self._conn = conn
        self._batch_size = batch_size
        self._buffer: list[RelayEnvelope] = []
        self._written = 0

    @staticmethod
    def _to_envelope(operation: Operation) -> RelayEnvelope:
        env = operation.envelope
        return RelayEnvelope(
            id=env.id,
            workspace_id=env.workspace_id,
            actor_id=env.actor_id,
            hlc=env.hlc,
            affected_node_ids=env.affected_node_ids,
            op_type=env.op_type,
            payload=operation.payload,
            timestamp=env.timestamp,
        )

    def write_operation(self, operation: Operation) -> None:
        """Buffer ``operation`` for bulk insertion.

        This method is synchronous because it is called from synchronous
        migration helpers. Callers must await :meth:`flush` to persist buffered
        envelopes; the migration script does this after each workspace phase.
        """
        self._buffer.append(self._to_envelope(operation))
        if self._batch_size > 0 and len(self._buffer) >= self._batch_size:
            # We cannot run an async flush here because this method is called
            # from synchronous code. The migration script is responsible for
            # flushing at async boundaries.
            pass

    async def flush(self) -> int:
        """Persist all buffered envelopes and return the number written."""
        if not self._buffer:
            return 0

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
            for envelope in self._buffer
        ]

        await self._conn.executemany(
            """
            INSERT INTO relay_envelope (
                id, workspace_id, actor_id, physical, logical,
                affected_node_ids, op_type, payload, timestamp
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
            ON CONFLICT (id) DO NOTHING
            """,
            rows,
        )

        written = len(self._buffer)
        self._written += written
        self._buffer.clear()
        return written

    async def count_operations(self, workspace_id: str) -> int:
        """Return the number of envelopes already stored for ``workspace_id``."""
        row = await self._conn.fetchrow(
            "SELECT COUNT(*) FROM relay_envelope WHERE workspace_id = $1",
            workspace_id,
        )
        return row[0] if row else 0

    def close(self) -> None:
        """Synchronous close is a no-op; use :meth:`aclose` from async code.

        This method exists to satisfy the :class:`OperationWriter` interface.
        The migration script must call ``await writer.aclose()`` before exiting
        so any buffered envelopes are persisted.
        """
        # Intentionally a no-op: flushing requires an async boundary and the
        # caller is responsible for awaiting aclose()/flush().

    async def aclose(self) -> int:
        """Flush any remaining envelopes and return the final flush count."""
        return await self.flush()

    @property
    def total_written(self) -> int:
        """Total envelopes persisted via :meth:`flush` so far."""
        return self._written
