"""Relay service orchestrating storage and permission checks."""

from __future__ import annotations

import asyncio
import json
import logging
from typing import Any

from app.core.clock import Hlc, compare_hlc
from app.core.validation import validate_payload
from app.relay.models import BatchRequest, CatchUpRequest, RelayEnvelope
from app.relay.permissions import PermissionChecker, PermissionDeniedError
from app.relay.storage import RelayStorage

logger = logging.getLogger(__name__)

MAX_BATCH_SIZE = 1000
MAX_ENVELOPE_SIZE_BYTES = 1024 * 1024  # 1 MB


class RelayService:
    """Accept operation batches and serve catch-up operations."""

    def __init__(
        self,
        storage: RelayStorage,
        permissions: PermissionChecker,
    ) -> None:
        self._storage = storage
        self._permissions = permissions

    @staticmethod
    async def _maybe_await(value: Any) -> Any:
        """Await coroutine results from async adapters, pass through sync ones."""
        if asyncio.iscoroutine(value):
            return await value
        return value

    @staticmethod
    def _validate_envelope(envelope: RelayEnvelope) -> None:
        """Validate size and HLC constraints for a single envelope."""
        if envelope.hlc.physical < 0 or envelope.hlc.logical < 0:
            raise ValueError("HLC components must be non-negative")
        if len(json.dumps(envelope.payload)) > MAX_ENVELOPE_SIZE_BYTES:
            raise ValueError("Envelope payload exceeds maximum size of 1 MB")

    async def receive_batch(
        self,
        batch: BatchRequest,
        actor_id: str,
    ) -> list[RelayEnvelope]:
        """Validate, permission-check, dedupe, and persist a batch of envelopes.

        Args:
            batch: The batch submitted by the client.
            actor_id: The authenticated actor making the request.

        Returns:
            The list of envelopes that were actually saved (duplicates excluded).

        Raises:
            PermissionDeniedError: If the actor is not authorized to submit any
                envelope in the batch.
            ValueError: If the batch or an individual envelope fails validation,
                or if envelopes target more than one workspace.
        """
        if len(batch.envelopes) > MAX_BATCH_SIZE:
            raise ValueError(f"Batch exceeds maximum of {MAX_BATCH_SIZE} envelopes")
        if not batch.envelopes:
            return []

        workspace_ids = {envelope.workspace_id for envelope in batch.envelopes}
        if len(workspace_ids) != 1:
            raise ValueError("All envelopes in a batch must belong to the same workspace")
        workspace_id = workspace_ids.pop()

        validated: list[RelayEnvelope] = []
        for envelope in batch.envelopes:
            self._validate_envelope(envelope)
            payload_error = validate_payload(envelope.op_type, envelope.payload)
            if payload_error is not None:
                raise ValueError(f"Invalid payload for {envelope.op_type}: {payload_error}")
            # The authenticated user is the only trustworthy actor identity.
            # Overwrite any client-provided actor_id to prevent impersonation.
            if envelope.actor_id != actor_id:
                envelope = envelope.model_copy(update={"actor_id": actor_id})
            validated.append(envelope)

        if not await self._permissions.can_write_batch(
            workspace_id,
            actor_id,
            [envelope.affected_node_ids for envelope in validated],
        ):
            raise PermissionDeniedError(
                f"Write denied for actor {actor_id} in workspace {workspace_id}"
            )

        saved_ids = await self._maybe_await(self._storage.save_envelopes(validated))
        saved_map = {envelope.id: envelope for envelope in validated}
        saved = [saved_map[saved_id] for saved_id in saved_ids]
        await self._notify_operation_listeners(saved)
        await self._broadcast_saved(workspace_id, saved)
        return saved

    async def _broadcast_saved(self, workspace_id: str, saved: list[RelayEnvelope]) -> None:
        """Forward a committed batch to WebSocket subscribers.

        This is the single broadcast point for both ingest paths (HTTP
        ``POST /batch`` and WS ``batch`` frames), so subscribers see every
        committed op regardless of how it arrived. The frame carries the
        server-assigned seq per envelope so receivers can advance their seq
        cursor from the live stream. Broadcast failures never break ingest —
        clients recover through the seq-cursor catch-up.
        """
        if not saved:
            return
        from app.relay.broadcast import broadcast

        try:
            seqs = await self._maybe_await(
                self._storage.get_envelope_seqs(workspace_id, [e.id for e in saved])
            )
            await broadcast(workspace_id, saved, seqs)
        except Exception:  # noqa: BLE001
            logger.exception("Broadcast failed for workspace %s", workspace_id)

    @staticmethod
    async def _notify_operation_listeners(saved: list[RelayEnvelope]) -> None:
        """Notify post-commit operation listeners about client-pushed ops.

        Client envelopes persisted here do not pass through a WorkspaceStore
        apply, so the store-level notification never sees them; features like
        continuous export reconciliation rely on this hook to react promptly.
        Listener failures never break ingest.
        """
        from app.core.derived.op_listeners import get as get_op_listeners
        from app.core.operation import Operation, OperationEnvelope

        listeners = get_op_listeners()
        if not listeners:
            return
        for envelope in saved:
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
            for listener in listeners:
                try:
                    result = listener(operation)
                    if asyncio.iscoroutine(result):
                        await result
                except Exception:  # noqa: BLE001
                    logger.exception("Operation listener failed for %s", envelope.id)

    async def catch_up(
        self,
        workspace_id: str,
        actor_id: str,
        after_seq: int = 0,
        share_token: str | None = None,
        share_node_id: str | None = None,
    ) -> list[RelayEnvelope]:
        """Return all operations with seq greater than ``after_seq`` that ``actor_id`` may read.

        Raises:
            PermissionDeniedError: If ``actor_id`` is not allowed to read the
                requested workspace.
        """
        if not await self._may_read(workspace_id, actor_id, share_token):
            raise PermissionDeniedError(f"Read denied for actor {actor_id} in workspace {workspace_id}")
        return await self._maybe_await(
            self._storage.get_catch_up(workspace_id, after_seq, node_id=share_node_id)
        )

    async def catch_up_paginated(
        self,
        workspace_id: str,
        actor_id: str,
        after_seq: int = 0,
        limit: int = 1000,
        share_token: str | None = None,
        share_node_id: str | None = None,
    ) -> tuple[list[RelayEnvelope], int | None, int]:
        """Return a paginated page of operations with seq greater than ``after_seq``.

        The third element is the total number of matching envelopes with
        ``seq`` greater than ``after_seq`` (including this page), for global
        progress reporting.

        Raises:
            PermissionDeniedError: If ``actor_id`` is not allowed to read the
                requested workspace.
        """
        if not await self._may_read(workspace_id, actor_id, share_token):
            raise PermissionDeniedError(f"Read denied for actor {actor_id} in workspace {workspace_id}")
        return await self._maybe_await(
            self._storage.get_catch_up_paginated(
                workspace_id,
                after_seq,
                limit=limit,
                node_id=share_node_id,
            )
        )

    async def catch_up_from_request(
        self,
        request: CatchUpRequest,
        actor_id: str,
        share_token: str | None = None,
    ) -> list[RelayEnvelope]:
        """Convenience wrapper for :meth:`catch_up` using a request model."""
        return await self.catch_up(
            request.workspace_id,
            actor_id,
            request.after_seq,
            share_token=share_token,
        )

    async def can_read_public_share(
        self,
        workspace_id: str,
        share_token: str,
        node_id: str | None = None,
    ) -> bool:
        """Return ``True`` if the share token grants read access to the workspace."""
        return await self._permissions.can_read_public_share(
            workspace_id,
            share_token,
            node_id=node_id,
        )

    async def get_public_share_node_id(
        self,
        workspace_id: str,
        share_token: str,
    ) -> str | None:
        """Return the node id that ``share_token`` grants access to, if any."""
        return await self._permissions.get_public_share_node_id(
            workspace_id,
            share_token,
        )

    async def get_max_hlc(self, workspace_id: str) -> Hlc:
        """Return the highest envelope HLC for ``workspace_id``."""
        return await self._maybe_await(self._storage.get_max_hlc(workspace_id))

    async def get_latest_seq(self, workspace_id: str) -> int:
        """Return the highest server-assigned envelope seq for ``workspace_id``."""
        return await self._maybe_await(self._storage.get_latest_seq(workspace_id))

    async def get_latest_snapshot(self, workspace_id: str) -> dict[str, Any] | None:
        """Return the newest snapshot for ``workspace_id``."""
        return await self._maybe_await(self._storage.get_latest_snapshot(workspace_id))

    async def get_latest_snapshot_metadata(self, workspace_id: str) -> dict[str, Any] | None:
        """Return the newest snapshot's metadata for ``workspace_id`` (no blob)."""
        return await self._maybe_await(self._storage.get_latest_snapshot_metadata(workspace_id))

    async def get_latest_snapshot_for_actor(
        self,
        workspace_id: str,
        actor_id: str,
        share_token: str | None = None,
    ) -> dict[str, Any] | None:
        """Return the newest snapshot if ``actor_id`` may read the workspace."""
        if not await self._may_read(workspace_id, actor_id, share_token):
            raise PermissionDeniedError(
                f"Actor {actor_id} cannot read workspace {workspace_id}"
            )
        return await self.get_latest_snapshot(workspace_id)

    async def get_latest_snapshot_metadata_for_actor(
        self,
        workspace_id: str,
        actor_id: str,
        share_token: str | None = None,
    ) -> dict[str, Any] | None:
        """Return the newest snapshot's metadata if ``actor_id`` may read the workspace."""
        if not await self._may_read(workspace_id, actor_id, share_token):
            raise PermissionDeniedError(
                f"Actor {actor_id} cannot read workspace {workspace_id}"
            )
        return await self.get_latest_snapshot_metadata(workspace_id)

    async def create_snapshot(
        self, workspace_id: str, up_to_hlc: Hlc, data: bytes = b""
    ) -> tuple[str, int]:
        """Create a snapshot covering all envelopes up to ``up_to_hlc``.

        Returns:
            A tuple of the new snapshot id and the highest envelope seq covered
            by the snapshot.

        Raises:
            ValueError: If ``up_to_hlc`` is ahead of the current maximum
                envelope HLC for the workspace.
        """
        max_hlc = await self.get_max_hlc(workspace_id)
        if compare_hlc(up_to_hlc, max_hlc) > 0:
            raise ValueError(
                "up_to_hlc cannot exceed the current maximum envelope HLC"
            )
        return await self._maybe_await(
            self._storage.create_snapshot(workspace_id, up_to_hlc, data=data)
        )

    async def create_compaction_segment(
        self,
        workspace_id: str,
        up_to_hlc: Hlc,
        prune: bool = True,
        data: bytes = b"",
    ) -> dict[str, Any]:
        """Create a snapshot and record a compacted operation segment.

        Raises:
            ValueError: If ``prune`` is ``True`` but ``data`` is empty.
        """
        return await self._maybe_await(
            self._storage.create_compaction_segment(
                workspace_id, up_to_hlc, prune=prune, data=data
            )
        )

    async def prune_envelopes(self, workspace_id: str, up_to_hlc: Hlc) -> int:
        """Delete envelopes with HLC less than or equal to ``up_to_hlc``."""
        return await self._maybe_await(self._storage.prune_envelopes(workspace_id, up_to_hlc))

    async def get_workspace_stats(
        self, workspace_id: str, actor_id: str, share_token: str | None = None
    ) -> dict[str, Any]:
        """Return operational statistics for ``workspace_id`` if readable."""
        if not await self._may_read(workspace_id, actor_id, share_token):
            raise PermissionDeniedError(
                f"Actor {actor_id} cannot read workspace {workspace_id}"
            )
        return await self._maybe_await(self._storage.get_workspace_stats(workspace_id))

    async def get_workspace_wrapped_key(self, workspace_id: str, actor_id: str) -> str | None:
        """Return the workspace's wrapped E2EE key blob if the actor may read."""
        if not await self._may_read(workspace_id, actor_id):
            raise PermissionDeniedError(
                f"Actor {actor_id} cannot read workspace {workspace_id}"
            )
        return await self._maybe_await(self._storage.get_workspace_wrapped_key(workspace_id))

    async def set_workspace_wrapped_key(self, workspace_id: str, wrapped_key: str) -> None:
        """Store the workspace's wrapped E2EE key blob (owner/admin via router)."""
        return await self._maybe_await(
            self._storage.set_workspace_wrapped_key(workspace_id, wrapped_key)
        )

    async def get_user_public_key(self, user_id: str) -> str | None:
        """Return a user's published X25519 public key (any authenticated caller)."""
        return await self._maybe_await(self._storage.get_user_public_key(user_id))

    async def set_user_public_key(self, actor_id: str, public_key: str) -> None:
        """Publish the caller's own X25519 public key; anonymous actors rejected."""
        if actor_id == "anonymous":
            raise PermissionDeniedError("Anonymous actors cannot publish a public key")
        return await self._maybe_await(self._storage.set_user_public_key(actor_id, public_key))

    async def get_member_keys(
        self, workspace_id: str, actor_id: str, user_id: str
    ) -> list[dict[str, Any]]:
        """Return a member's wrapped workspace-key copies.

        Members may read only their own wrapped copies, and only when they can
        read the workspace at all.
        """
        if actor_id != user_id:
            raise PermissionDeniedError(
                f"Actor {actor_id} cannot read member keys for {user_id}"
            )
        if not await self._may_read(workspace_id, actor_id):
            raise PermissionDeniedError(
                f"Actor {actor_id} cannot read workspace {workspace_id}"
            )
        return await self._maybe_await(self._storage.get_member_keys(workspace_id, user_id))

    async def set_member_key(
        self, workspace_id: str, user_id: str, key_version: int, wrapped_key: str
    ) -> None:
        """Store one wrapped workspace-key copy for a member (owner/admin via router)."""
        return await self._maybe_await(
            self._storage.set_member_key(workspace_id, user_id, key_version, wrapped_key)
        )

    async def delete_member_keys(self, workspace_id: str, user_id: str) -> int:
        """Delete all wrapped workspace-key copies for a member (owner/admin via router)."""
        return await self._maybe_await(self._storage.delete_member_keys(workspace_id, user_id))

    async def _may_read(
        self,
        workspace_id: str,
        actor_id: str,
        share_token: str | None = None,
    ) -> bool:
        """Return ``True`` if the actor may read the workspace.

        Anonymous actors may read via a valid public-share token; authenticated
        actors are checked through normal workspace membership.
        """
        if actor_id != "anonymous":
            return await self._permissions.can_read(workspace_id, actor_id)
        if share_token is not None:
            return await self._permissions.can_read_public_share(
                workspace_id,
                share_token,
            )
        return False
