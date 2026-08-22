"""Local-first SyncEngine for the Notees backend.

Ports ``frontend/src/core/sync.ts`` to Python. The engine pushes operations
persisted by a ``WorkspaceStore`` through a ``Transport``, pulls remote
operations back, and applies them to the store's derived state.
"""

from __future__ import annotations

from app.core.clock import Hlc, max_hlc
from app.core.operation import Operation, OperationEnvelope
from app.core.transport import Transport
from app.core.workspace_store import WorkspaceStore


class SyncEngine:
    """Push/pull operations between a ``WorkspaceStore`` and a ``Transport``."""

    def __init__(
        self,
        store: WorkspaceStore,
        transport: Transport,
    ) -> None:
        self._store = store
        self._transport = transport
        self._last_received_hlc = Hlc(0, 0)

    async def push(self) -> int:
        """Send all operations persisted by this store to the relay."""
        envelopes = await self._store.get_envelopes(0)
        for envelope in envelopes:
            await self._transport.send(envelope)
        return len(envelopes)

    async def pull(self) -> int:
        """Fetch operations newer than the last received HLC and apply them."""
        envelopes = await self._transport.catch_up(self._last_received_hlc)
        envelopes.sort(key=lambda env: (env.hlc.physical, env.hlc.logical, env.id))
        for envelope in envelopes:
            operation = Operation(
                envelope=OperationEnvelope(
                    id=envelope.id,
                    workspace_id=envelope.workspace_id,
                    actor_id=envelope.actor_id,
                    hlc=envelope.hlc,
                    affected_node_ids=envelope.affected_node_ids,
                    op_type=envelope.op_type,
                    timestamp=envelope.timestamp,
                ),
                payload=envelope.payload,
            )
            await self._store.apply(operation)
            self._last_received_hlc = max_hlc(self._last_received_hlc, envelope.hlc)
        return len(envelopes)

    async def sync_once(self) -> tuple[int, int]:
        """Push then pull once. Returns ``(pushed, pulled)``."""
        pushed = await self.push()
        pulled = await self.pull()
        return pushed, pulled
