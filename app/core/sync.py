"""Local-first SyncEngine for the Notees backend.

Ports ``frontend/src/core/sync.ts`` to Python. The engine pushes locally logged
operations through a ``Transport``, pulls remote operations back, decrypts them,
and applies them to the ``WorkspaceStore``.
"""

from __future__ import annotations

import json

from app.core.clock import Hlc, max_hlc
from app.core.crypto import decrypt_operation_payload, encrypt_operation_payload
from app.core.operation import create_operation
from app.core.store import WorkspaceStore
from app.core.transport import Transport
from app.relay.models import EncryptedEnvelope


class SyncEngine:
    """Push/pull operations between a ``WorkspaceStore`` and a ``Transport``."""

    def __init__(
        self,
        store: WorkspaceStore,
        key: bytes,
        transport: Transport,
    ) -> None:
        self._store = store
        self._key = key
        self._transport = transport
        self._last_received_hlc = store.get_watermark()

    async def push(self) -> int:
        """Encrypt and send all operations in the local operation log."""
        rows = self._store.get_db().execute(
            """
            SELECT
                id,
                workspace_id,
                actor_id,
                hlc_physical,
                hlc_logical,
                affected_node_ids,
                op_type,
                payload
            FROM operation
            WHERE workspace_id = ?
            ORDER BY hlc_physical ASC, hlc_logical ASC
            """,
            (self._store.workspace_id,),
        ).fetchall()

        for row in rows:
            payload = json.loads(row[7])
            encrypted = encrypt_operation_payload(payload, self._key)
            envelope = EncryptedEnvelope(
                id=row[0],
                workspace_id=row[1],
                actor_id=row[2],
                hlc=Hlc(physical=row[3], logical=row[4]),
                affected_node_ids=json.loads(row[5]),
                op_type=row[6],
                ciphertext=encrypted["ciphertext"],
                iv=encrypted["iv"],
            )
            await self._transport.send(envelope)

        return len(rows)

    async def pull(self) -> int:
        """Fetch operations newer than the watermark and apply them."""
        envelopes = await self._transport.catch_up(self._last_received_hlc)
        envelopes.sort(key=lambda env: (env.hlc.physical, env.hlc.logical, env.id))
        for envelope in envelopes:
            payload = decrypt_operation_payload(
                envelope.ciphertext,
                envelope.iv,
                self._key,
            )
            op = create_operation(
                {
                    "id": envelope.id,
                    "workspace_id": envelope.workspace_id,
                    "actor_id": envelope.actor_id,
                    "hlc": envelope.hlc,
                    "affected_node_ids": envelope.affected_node_ids,
                    "op_type": envelope.op_type,
                },
                payload,
            )
            self._store.apply(op)
            self._last_received_hlc = max_hlc(self._last_received_hlc, envelope.hlc)
        return len(envelopes)

    async def sync_once(self) -> tuple[int, int]:
        """Push then pull once. Returns ``(pushed, pulled)``."""
        pushed = await self.push()
        pulled = await self.pull()
        return pushed, pulled
