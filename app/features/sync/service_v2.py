"""v2 optimistic vector-clock sync service."""

from __future__ import annotations

import json

from app.db.connection import get_transaction
from app.domain.entities.node import NodeCreateData, NodeUpdateData
from app.domain.entities.sync_v2 import (
    AppliedOperation,
    BaseVector,
    OperationIntent,
    SyncBatchRequest,
    SyncBatchResponse,
    SyncConflictResponse,
    VersionVector,
)
from app.domain.permissions import PermissionChecker
from app.features.nodes.node_service import NodeService
from app.features.properties.service import PropertyNotFoundError, PropertyService
from app.features.sync.port import SyncRepository
from app.logging_config import get_logger

logger = get_logger(__name__)


class SyncServiceV2:
    """Apply batches of client operations using per-node version vectors."""

    def __init__(
        self,
        sync_repo: SyncRepository,
        node_service: NodeService,
        permission_checker: PermissionChecker,
        workspace_id: int,
        user_id: int,
        workspace_uuid: str | None = None,
        property_service: PropertyService | None = None,
    ):
        self._sync_repo = sync_repo
        self._node_service = node_service
        self._permission_checker = permission_checker
        self._workspace_id = workspace_id
        self._user_id = user_id
        self._workspace_uuid = workspace_uuid
        self._property_service = property_service

    async def apply_batch(self, request: SyncBatchRequest) -> SyncBatchResponse | SyncConflictResponse:
        """Validate vectors and apply a batch of operations atomically."""
        # Resolve existing node UUIDs referenced by operations (excluding create targets).
        node_ids = self._classify_op_uuids(request)
        resolved, missing_resolved = await self._resolve_existing_uuids(node_ids)
        if missing_resolved:
            return SyncConflictResponse(
                stale_nodes=list(missing_resolved),
                server_vectors={},
                conflict_type="node_deleted",
            )

        # Determine the set of existing nodes whose vectors must be validated.
        required_nodes = self._collect_required_nodes(request, resolved)
        server_vectors = {
            str(uuid): vec
            for uuid, vec in (
                await self._sync_repo.get_vectors_by_uuids(list(required_nodes.keys()))
            ).items()
        }

        # Validate base_vector against server vectors.
        stale, stale_type = self._validate_base_vector(request.base_vector, server_vectors)
        if stale:
            return SyncConflictResponse(
                stale_nodes=stale,
                server_vectors={uuid: server_vectors.get(uuid, {}) for uuid in stale},
                conflict_type=stale_type,
            )

        # Everything matches — apply operations inside a single transaction.
        async with get_transaction():
            applied_ops: list[AppliedOperation] = []
            vector_updates: list[tuple[int, str, int]] = []
            created_ids: dict[str, int] = {}

            for op in request.ops:
                target_uuid = op.node_uuid
                target_id = resolved.get(target_uuid) or created_ids.get(target_uuid)
                applied = await self._apply_operation(op, target_id, resolved, created_ids)
                if applied is not None:
                    applied_ops.append(applied)

                # Advance the target node's vector. For creates, the new ID is now known.
                final_target_id = created_ids.get(target_uuid) or resolved.get(target_uuid)
                if final_target_id is not None:
                    vector_updates.append((final_target_id, op.client_id, op.seq))

                # Anchor parents also advance for tree ops.
                if op.type in {"move", "create"} and op.parent_uuid:
                    parent_id = resolved.get(op.parent_uuid)
                    if parent_id is not None:
                        vector_updates.append((parent_id, op.client_id, op.seq))

            new_vectors = await self._sync_repo.advance_vectors(vector_updates)

        # Broadcast applied ops to other clients on the same workspace.
        await self._broadcast_ops(applied_ops)

        # Convert new vectors from node_id keys to uuid keys.
        uuid_vectors = await self._map_vectors_to_uuids(new_vectors, resolved, created_ids)
        return SyncBatchResponse(applied=True, new_vectors=uuid_vectors)

    def _classify_op_uuids(self, request: SyncBatchRequest) -> set[str]:
        """Return the set of existing node UUIDs referenced by the batch.

        For create operations the target UUID is expected to be missing on the
        server, so it is excluded. Parent UUIDs are always expected to exist.
        Anchor siblings (after_uuid) must also exist so the server can compute
        the correct sequence.
        """
        existing: set[str] = set()
        for op in request.ops:
            if op.type != "create":
                existing.add(op.node_uuid)
            if op.parent_uuid:
                existing.add(op.parent_uuid)
            if op.after_uuid:
                existing.add(op.after_uuid)
        return existing

    async def _resolve_existing_uuids(
        self, uuids: set[str]
    ) -> tuple[dict[str, int], set[str]]:
        """Resolve a set of UUIDs that are expected to exist on the server."""
        resolved: dict[str, int] = {}
        missing: set[str] = set()
        for uuid in uuids:
            row = await self._sync_repo.get_node_state_by_uuid(uuid)
            if row:
                resolved[uuid] = row["id"]
            else:
                missing.add(uuid)
        return resolved, missing

    def _collect_required_nodes(
        self, request: SyncBatchRequest, resolved: dict[str, int]
    ) -> dict[str, int]:
        """Build the set of existing node UUIDs whose vectors must match base_vector."""
        required: dict[str, int] = {}
        for op in request.ops:
            if op.node_uuid in resolved:
                required[op.node_uuid] = resolved[op.node_uuid]
            if op.parent_uuid and op.parent_uuid in resolved:
                required[op.parent_uuid] = resolved[op.parent_uuid]
        return required

    def _validate_base_vector(
        self,
        base_vector: BaseVector,
        server_vectors: BaseVector,
    ) -> tuple[list[str], str]:
        """Check that the client's base vector matches the server.

        Returns (stale_node_uuids, conflict_type). Empty list means no conflict.
        """
        stale: list[str] = []
        # Check every node that either the client or server has a vector for.
        for uuid in set(base_vector.keys()) | set(server_vectors.keys()):
            client_vec = base_vector.get(uuid, {})
            server_vec = server_vectors.get(uuid, {})
            # A node is stale if the server has any client entry with a higher seq.
            for client_id, client_seq in client_vec.items():
                server_seq = server_vec.get(client_id, 0)
                if client_seq < server_seq:
                    stale.append(uuid)
                    break
            else:
                # If the server has entries the client doesn't, the client is behind.
                if server_vec and not all(cid in client_vec for cid in server_vec):
                    stale.append(uuid)
        # Deduplicate while preserving order
        seen = set()
        unique_stale = [u for u in stale if not (u in seen or seen.add(u))]
        return unique_stale, "text_edit"

    def _resolve_anchor_id(
        self,
        anchor_uuid: str | None,
        resolved: dict[str, int],
        created_ids: dict[str, int],
    ) -> int | None:
        """Resolve an anchor UUID (parent/after) to a numeric node id."""
        if not anchor_uuid:
            return None
        return resolved.get(anchor_uuid) or created_ids.get(anchor_uuid)

    async def _compute_sequence(
        self,
        parent_id: int | None,
        after_id: int | None,
    ) -> float:
        """Compute a sibling sequence that places a node after ``after_id``.

        Mirrors the client-side ordering logic in the operation reducer:
        - ``after_id`` provided  → midpoint between it and the next sibling.
        - ``after_id`` is None   → prepend before the first child.
        - No children            → start at 0.
        """
        if parent_id is None:
            return 0.0

        repo = self._node_service._node_repo
        children = await repo.get_children_ids(parent_id)
        if not children:
            return 0.0

        if after_id is None:
            first_seq = await repo.get_node_sequence(children[0])
            return (first_seq if first_seq is not None else 0.0) - 1024.0

        if after_id not in children:
            # Anchor sibling missing or in a different parent; append at the end.
            return await repo.get_max_sequence(parent_id) + 1024.0

        after_index = children.index(after_id)
        after_seq = await repo.get_node_sequence(after_id)
        if after_seq is None:
            after_seq = 0.0

        if after_index >= len(children) - 1:
            return after_seq + 1024.0

        before_seq = await repo.get_node_sequence(children[after_index + 1])
        if before_seq is None:
            before_seq = after_seq + 1024.0

        gap = before_seq - after_seq
        if gap < 1e-9:
            # No room between siblings; shift later siblings and land in the middle.
            await repo.shift_sequences(parent_id, after_seq, 1024.0)
            return after_seq + 512.0

        return after_seq + gap / 2.0

    async def _apply_operation(
        self,
        op: OperationIntent,
        target_id: int | None,
        resolved: dict[str, int],
        created_ids: dict[str, int],
    ) -> AppliedOperation | None:
        """Apply a single operation via NodeService."""
        if op.type != "create" and target_id is None:
            logger.warning("Skipping %s op for unknown node %s", op.type, op.node_uuid)
            return None

        if op.type == "update_content":
            content = op.content_ast
            name = json.dumps(content) if content is not None else None
            await self._node_service.update_node(
                target_id,
                NodeUpdateData(name=name),
                user_id=self._user_id,
            )

        elif op.type == "update_node":
            data = NodeUpdateData(name=op.name)
            classes: list[int] | None = None
            tags: list[int] | None = None
            if op.properties:
                for key, value in op.properties.items():
                    if key == "icon":
                        data.icon = value
                    elif key == "color":
                        data.color = value
                    elif key == "class_uuids" and isinstance(value, list):
                        classes = [
                            class_id
                            for class_uuid in value
                            if (class_id := await self._node_service._node_repo.find_node_id_by_uuid(class_uuid))
                            is not None
                        ]
                    elif key == "tag_uuids" and isinstance(value, list):
                        tags = [
                            tag_id
                            for tag_uuid in value
                            if (tag_id := await self._node_service._node_repo.find_node_id_by_uuid(tag_uuid))
                            is not None
                        ]
            await self._node_service.update_node(
                target_id, data, classes=classes, tags=tags, user_id=self._user_id
            )

        elif op.type == "create":
            content = op.content_ast or []
            name = json.dumps(content)
            parent_id = self._resolve_anchor_id(op.parent_uuid, resolved, created_ids)
            after_id = self._resolve_anchor_id(op.after_uuid, resolved, created_ids)
            sequence = await self._compute_sequence(parent_id, after_id)
            node = await self._node_service.create_raw_node(
                NodeCreateData(
                    name=name,
                    parent_id=parent_id,
                    sequence=sequence,
                    is_page=op.is_page,
                    is_task=op.is_task,
                    is_daily=op.is_daily,
                    is_monthly=op.is_monthly,
                    is_yearly=op.is_yearly,
                ),
                uuid=op.node_uuid,
            )
            if node.id is not None:
                created_ids[op.node_uuid] = node.id

        elif op.type == "move":
            parent_id = self._resolve_anchor_id(op.parent_uuid, resolved, created_ids)
            after_id = self._resolve_anchor_id(op.after_uuid, resolved, created_ids)
            new_sequence = await self._compute_sequence(parent_id, after_id)
            await self._node_service.move_node(
                target_id,
                new_parent_id=parent_id,
                new_sequence=new_sequence,
                user_id=self._user_id,
            )

        elif op.type == "delete":
            await self._node_service.delete_node(target_id, user_id=self._user_id)

        elif op.type == "restore":
            await self._node_service.restore_node(target_id, user_id=self._user_id)

        elif op.type == "add_class":
            if op.class_uuid:
                class_id = await self._node_service._node_repo.find_node_id_by_uuid(op.class_uuid)
                if class_id:
                    await self._node_service.add_class(target_id, class_id)

        elif op.type == "remove_class":
            if op.class_uuid:
                class_id = await self._node_service._node_repo.find_node_id_by_uuid(op.class_uuid)
                if class_id:
                    await self._node_service.remove_class(target_id, class_id)

        elif op.type == "add_tag":
            if op.tag_uuid:
                tag_id = await self._node_service._node_repo.find_node_id_by_uuid(op.tag_uuid)
                if tag_id:
                    await self._node_service.add_tag_link(target_id, tag_id)

        elif op.type == "remove_tag":
            if op.tag_uuid:
                tag_id = await self._node_service._node_repo.find_node_id_by_uuid(op.tag_uuid)
                if tag_id:
                    await self._node_service.remove_tag_link(target_id, tag_id)

        elif op.type == "set_property":
            if not self._property_service:
                logger.warning("Skipping set_property op: no property service available")
                return None
            if not op.property_uuid:
                logger.warning("Skipping set_property op for node %s: missing property_uuid", op.node_uuid)
                return None
            try:
                await self._property_service.set_property_value_by_uuid(
                    target_id, op.property_uuid, op.property_value
                )
            except PropertyNotFoundError:
                logger.warning(
                    "Skipping set_property op: property %s or target not found",
                    op.property_uuid,
                )
                return None
            except ValueError:
                logger.warning(
                    "Skipping set_property op: invalid value for property %s",
                    op.property_uuid,
                    exc_info=True,
                )
                return None

        else:
            logger.warning("Unknown sync v2 op type: %s", op.type)
            return None

        return AppliedOperation(
            type=op.type,
            node_uuid=op.node_uuid,
            client_id=op.client_id,
            seq=op.seq,
            parent_uuid=op.parent_uuid,
            after_uuid=op.after_uuid,
        )

    async def _broadcast_ops(self, ops: list[AppliedOperation]) -> None:
        """Broadcast applied ops to other connected clients.

        Uses the workspace-scoped live-sync WebSocket broadcast channel.
        Falls back to the numeric workspace id only when the uuid is unknown.
        """
        if not ops:
            return
        try:
            from app.features.collab.live_sync_ws import broadcast_ops

            room = self._workspace_uuid if self._workspace_uuid else str(self._workspace_id)
            await broadcast_ops(room, [op.model_dump() for op in ops])
        except Exception:
            logger.exception("Failed to broadcast applied ops")

    async def _map_vectors_to_uuids(
        self,
        vectors: dict[int, VersionVector],
        resolved: dict[str, int],
        created_ids: dict[str, int],
    ) -> BaseVector:
        """Convert node_id-keyed vectors to uuid-keyed vectors."""
        uuid_by_id = {node_id: uuid for uuid, node_id in resolved.items()}
        uuid_by_id.update(
            {node_id: uuid for uuid, node_id in created_ids.items()}
        )
        return {uuid_by_id[nid]: vec for nid, vec in vectors.items() if nid in uuid_by_id}
