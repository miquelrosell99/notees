"""Idempotent-replay harness for derived-state appliers.

Every operation type in ``KNOWN_OP_TYPES`` is classified into exactly one
bucket, and the classification is enforced by tests, not by assumption:

* ``IDEMPOTENT_BY_DESIGN`` — applying the same operation (same id, same
  payload) twice through the raw applier leaves the derived database
  identical. These appliers use ``INSERT OR IGNORE`` / upserts, HLC
  last-write-wins guards, or delete-then-replace with deterministic ids.
* ``DEDUPE_PROTECTED`` — the applier is intentionally non-idempotent
  (``link.click`` increments ``click_count`` on every application; see
  ``app/core/derived/link.py``). Duplicate-delivery protection lives in the
  ``applied_operation_id`` dedupe in ``WorkspaceStore.sync()`` /
  ``WorkspaceStore.apply()``, not in the applier. For these, the raw applier
  MUST change state on double apply (proving the harness can detect
  non-idempotency) while the sync path MUST NOT.
* ``NO_BACKEND_APPLIER`` — op types known to the relay protocol but without a
  backend derived-state applier. The frontend projects them
  (``frontend/src/core/derived/node.ts``); ``apply_operation`` raises
  ``ValueError`` for them here.

An undocumented non-idempotent applier fails ``TestIdempotentReplay``; a new
op type missing from the registry fails ``test_registry_covers_known_op_types``.
"""

from __future__ import annotations

import copy
import sqlite3
from typing import Any

import pytest

from app.core.clock import Hlc
from app.core.derived import apply_operation, create_derived_schema
from app.core.derived import flashcard as flashcard_module
from app.core.operation import KNOWN_OP_TYPES, Operation
from app.core.validation import validate_payload
from app.core.workspace_store import WorkspaceStore
from app.relay.models import RelayEnvelope
from tests.core.derived.conftest import make_operation

pytestmark = pytest.mark.unit

# ---------------------------------------------------------------------------
# Bucket registry (see module docstring for the contract of each bucket).
# ---------------------------------------------------------------------------

DEDUPE_PROTECTED: frozenset[str] = frozenset({"link.click"})

NO_BACKEND_APPLIER: frozenset[str] = frozenset(
    {"node.addAlias", "node.removeAlias", "node.permanentDelete"}
)

IDEMPOTENT_BY_DESIGN: frozenset[str] = (
    KNOWN_OP_TYPES - DEDUPE_PROTECTED - NO_BACKEND_APPLIER
)

# ---------------------------------------------------------------------------
# Per-op-type minimal valid payload fixtures.
#
# ``setup`` entries are ``(op_type, payload_overrides)`` pairs applied once
# before the target operation so the target exercises its real code path
# (e.g. LWW guards against existing rows). ``physical`` raises the target
# operation's HLC above setup operations where an applier requires strictly
# newer timestamps to act.
# ---------------------------------------------------------------------------

_FIXTURES: dict[str, dict[str, Any]] = {
    "node.create": {
        "payload": {
            "nodeId": "node-1",
            "kind": "page",
            "index": 0,
            # Exercises the search-index and edge/node_link rebuild paths,
            # including the random-uuid edge insert in ``edge.py``.
            "initialContent": [{"type": "text", "text": "links to [[node-2]]"}],
        },
    },
    "node.delete": {
        "setup": [("node.create", {})],
        "payload": {"nodeId": "node-1"},
    },
    "node.move": {
        "setup": [("node.create", {}), ("node.create", {"nodeId": "parent-1"})],
        "payload": {"nodeId": "node-1", "newParentId": "parent-1", "newIndex": 0},
    },
    "node.updateContent": {
        "setup": [("node.create", {})],
        "payload": {"nodeId": "node-1", "content": [{"type": "text", "text": "hello"}]},
    },
    "node.updateIcon": {
        "setup": [("node.create", {})],
        "payload": {"nodeId": "node-1", "icon": "star"},
    },
    "node.updateColor": {
        "setup": [("node.create", {})],
        "payload": {"nodeId": "node-1", "color": "red"},
    },
    "node.addAlias": {
        "payload": {"canonicalNodeId": "node-1", "aliasNodeId": "alias-1"},
    },
    "node.removeAlias": {
        "payload": {"canonicalNodeId": "node-1", "aliasNodeId": "alias-1"},
    },
    "node.archive": {
        "setup": [("node.create", {})],
        "payload": {"nodeId": "node-1"},
    },
    "node.restore": {
        "setup": [("node.create", {}), ("node.archive", {})],
        "payload": {"nodeId": "node-1"},
    },
    "node.permanentDelete": {
        "payload": {"nodeId": "node-1"},
    },
    "node.convert": {
        "setup": [("node.create", {}), ("node.create", {"nodeId": "parent-1"})],
        "payload": {"nodeId": "node-1", "kind": "block", "parentId": "parent-1"},
    },
    "class.assign": {
        "setup": [("node.create", {})],
        "payload": {"nodeId": "node-1", "classId": "class-1"},
    },
    "class.unassign": {
        "setup": [("node.create", {}), ("class.assign", {})],
        "payload": {"nodeId": "node-1", "classId": "class-1"},
    },
    "property.set": {
        "payload": {
            "propertyValueId": "pv-1",
            "nodeId": "node-1",
            "schemaId": "schema-1",
            "value": "done",
        },
    },
    "property.unset": {
        "setup": [("property.set", {})],
        # Strictly newer than the set so the LWW guard lets the unset through.
        "physical": 2,
        "payload": {"nodeId": "node-1", "schemaId": "schema-1"},
    },
    "propertySchema.create": {
        "payload": {"schemaId": "schema-1", "name": "Status", "type": "text"},
    },
    "propertySchema.update": {
        "setup": [("propertySchema.create", {})],
        "payload": {"schemaId": "schema-1", "name": "State"},
    },
    "propertySchema.delete": {
        "setup": [("propertySchema.create", {})],
        "payload": {"schemaId": "schema-1"},
    },
    "classPropertyEdge.create": {
        "payload": {"classId": "class-1", "propertySchemaId": "schema-1"},
    },
    "classPropertyEdge.update": {
        "setup": [("classPropertyEdge.create", {})],
        "payload": {"classId": "class-1", "propertySchemaId": "schema-1", "sequence": 2},
    },
    "classPropertyEdge.delete": {
        "setup": [("classPropertyEdge.create", {})],
        "payload": {"classId": "class-1", "propertySchemaId": "schema-1"},
    },
    "classPropertyEdge.reorder": {
        "setup": [("classPropertyEdge.create", {})],
        "payload": {"classId": "class-1", "orderedPropertySchemaIds": ["schema-1"]},
    },
    "class.create": {
        "payload": {"classId": "class-1", "name": "Task"},
    },
    "class.update": {
        "setup": [("class.create", {})],
        "payload": {"classId": "class-1", "name": "Chore"},
    },
    "class.delete": {
        "setup": [("class.create", {})],
        "payload": {"classId": "class-1"},
    },
    "class.setExtends": {
        "setup": [("class.create", {}), ("class.create", {"classId": "class-2", "name": "Base"})],
        "payload": {"classId": "class-1", "extendsClassIds": ["class-2"]},
    },
    "nodeView.create": {
        "payload": {"viewId": "view-1", "nodeId": "node-1", "name": "All", "viewType": "table"},
    },
    "nodeView.update": {
        "setup": [("nodeView.create", {})],
        "payload": {"viewId": "view-1", "name": "Board"},
    },
    "nodeView.delete": {
        "setup": [("nodeView.create", {})],
        "payload": {"viewId": "view-1"},
    },
    "nodeView.reorder": {
        "setup": [("nodeView.create", {})],
        "payload": {"nodeId": "node-1", "viewType": "table", "orderedViewIds": ["view-1"]},
    },
    "task.recordCompletion": {
        "payload": {"completionId": "comp-1", "nodeId": "node-1"},
    },
    "task.deleteCompletion": {
        "setup": [("task.recordCompletion", {})],
        "payload": {"nodeId": "node-1", "completionId": "comp-1"},
    },
    "task.setRecurrence": {
        "payload": {"recurrenceId": "rec-1", "nodeId": "node-1", "rule": {"freq": "daily"}},
    },
    "task.deleteRecurrence": {
        "setup": [("task.setRecurrence", {})],
        "payload": {"nodeId": "node-1", "recurrenceId": "rec-1"},
    },
    "asset.upload": {
        "payload": {
            "nodeId": "node-1",
            "assetHash": "hash-1",
            "mimeType": "image/png",
            "sizeBytes": 3,
            "originalName": "a.png",
        },
    },
    "asset.delete": {
        "setup": [("asset.upload", {})],
        "payload": {"nodeId": "node-1"},
    },
    "activity.record": {
        "setup": [("node.create", {})],
        "payload": {
            "activityId": "act-1",
            "nodeId": "node-1",
            "action": "property_changed",
        },
    },
    "activity.delete": {
        "setup": [("activity.record", {})],
        "payload": {"activityId": "act-1", "nodeId": "node-1"},
    },
    "link.click": {
        "payload": {
            "sourceNodeId": "node-1",
            "targetNodeId": "node-2",
        },
    },
    "share.public.create": {
        "payload": {"shareId": "share-1", "nodeId": "node-1", "slug": "slug-1"},
    },
    "share.public.revoke": {
        "setup": [("share.public.create", {})],
        "payload": {"shareId": "share-1", "nodeId": "node-1"},
    },
    "share.user.grant": {
        "payload": {
            "shareId": "share-2",
            "nodeId": "node-1",
            "targetUserId": "user-2",
            "permissionBits": 1,
        },
    },
    "share.user.revoke": {
        "setup": [("share.user.grant", {})],
        "payload": {"shareId": "share-2", "nodeId": "node-1", "targetUserId": "user-2"},
    },
    "user.favorite.add": {
        "payload": {"nodeId": "node-1"},
    },
    "user.favorite.remove": {
        "setup": [("user.favorite.add", {})],
        "payload": {"nodeId": "node-1"},
    },
    "user.favorite.reorder": {
        "setup": [("user.favorite.add", {})],
        "payload": {"nodeIds": ["node-1"]},
    },
    "plugin.op": {
        # Unknown plugin id exercises the ``plugin_op_log`` fallback path.
        "payload": {
            "pluginId": "test.plugin",
            "opType": "custom.op",
            "data": {"key": "value"},
            "nodeId": "node-1",
        },
    },
}


def _build_operation_chain(op_type: str) -> list[Operation]:
    """Return setup operations followed by the target operation for ``op_type``."""
    spec = _FIXTURES[op_type]
    operations = [
        make_operation(
            setup_op_type,
            {**copy.deepcopy(_FIXTURES[setup_op_type]["payload"]), **overrides},
        )
        for setup_op_type, overrides in spec.get("setup", [])
    ]
    operations.append(
        make_operation(
            op_type,
            copy.deepcopy(spec["payload"]),
            physical=spec.get("physical", 1),
        )
    )
    return operations


def _new_derived_conn() -> sqlite3.Connection:
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    create_derived_schema(conn)
    return conn


def _snapshot_database(conn: sqlite3.Connection) -> dict[str, list[tuple[Any, ...]]]:
    """Dump every table's rows, ordered deterministically, for comparison."""
    tables = [
        row[0]
        for row in conn.execute(
            "SELECT name FROM sqlite_master "
            "WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
        )
    ]
    return {
        table: sorted(
            (tuple(row) for row in conn.execute(f'SELECT * FROM "{table}"')),
            key=repr,
        )
        for table in tables
    }


def _changed_tables(
    before: dict[str, list[tuple[Any, ...]]],
    after: dict[str, list[tuple[Any, ...]]],
) -> list[str]:
    return sorted(table for table in before if before[table] != after.get(table))


class _FixedKeyStorage:
    """In-memory key storage avoiding PostgreSQL in unit tests."""

    async def get_or_create_master_key(self, workspace_id: str, secret_key: str) -> bytes:
        return b"0" * 32


class _FakeRelayStorage:
    """Minimal in-memory relay storage for ``WorkspaceStore.sync()`` tests.

    Implements only the two port methods ``sync()`` calls, so the test
    exercises the real dedupe logic in ``WorkspaceStore`` while staying
    decoupled from the concrete storage adapters (whose pagination signature
    is being refactored independently of the dedupe contract under test).
    """

    def __init__(self) -> None:
        self._envelopes: list[RelayEnvelope] = []

    def save_envelope(self, envelope: RelayEnvelope) -> None:
        if all(existing.id != envelope.id for existing in self._envelopes):
            self._envelopes.append(envelope)

    def get_latest_snapshot(self, workspace_id: str) -> None:
        return None

    def get_catch_up_paginated(
        self,
        workspace_id: str,
        after_seq: int = 0,
        limit: int = 1000,
        node_id: str | None = None,
    ) -> tuple[list[RelayEnvelope], int | None]:
        # seq = insertion order (server-assigned, monotonic, dedupe-stable).
        ordered = [
            envelope for envelope in self._envelopes if envelope.workspace_id == workspace_id
        ]
        page = ordered[after_seq : after_seq + limit]
        next_after_seq = after_seq + limit if len(ordered) > after_seq + limit else None
        return page, next_after_seq

    def close(self) -> None:
        pass


def _to_envelope(operation: Operation) -> RelayEnvelope:
    envelope = operation.envelope
    return RelayEnvelope(
        id=envelope.id,
        workspace_id=envelope.workspace_id,
        actor_id=envelope.actor_id,
        hlc=Hlc(physical=envelope.hlc.physical, logical=envelope.hlc.logical),
        affected_node_ids=envelope.affected_node_ids,
        op_type=envelope.op_type,
        timestamp=envelope.timestamp,
        payload=operation.payload,
    )


class TestRegistryCoverage:
    def test_registry_covers_known_op_types(self) -> None:
        union = IDEMPOTENT_BY_DESIGN | DEDUPE_PROTECTED | NO_BACKEND_APPLIER
        total = len(IDEMPOTENT_BY_DESIGN) + len(DEDUPE_PROTECTED) + len(NO_BACKEND_APPLIER)
        assert union == KNOWN_OP_TYPES, (
            f"unclassified: {sorted(KNOWN_OP_TYPES - union)}, "
            f"unknown: {sorted(union - KNOWN_OP_TYPES)}"
        )
        assert len(union) == total, "buckets must be disjoint"

    def test_every_known_op_type_has_a_fixture(self) -> None:
        assert set(_FIXTURES) == KNOWN_OP_TYPES

    @pytest.mark.parametrize("op_type", sorted(KNOWN_OP_TYPES))
    def test_fixture_payload_is_valid(self, op_type: str) -> None:
        assert validate_payload(op_type, copy.deepcopy(_FIXTURES[op_type]["payload"])) is None


class TestIdempotentReplay:
    """Raw double application of the same operation must be a no-op."""

    @pytest.mark.parametrize("op_type", sorted(IDEMPOTENT_BY_DESIGN))
    def test_double_apply_leaves_derived_state_unchanged(self, op_type: str) -> None:
        operations = _build_operation_chain(op_type)
        target = operations[-1]
        conn = _new_derived_conn()
        for operation in operations:
            apply_operation(conn, operation)
        conn.commit()
        before = _snapshot_database(conn)

        apply_operation(conn, target)
        conn.commit()
        after = _snapshot_database(conn)

        assert before == after, (
            f"{op_type} is not idempotent; changed tables: "
            f"{_changed_tables(before, after)}. If this is intentional, move the "
            "op type to DEDUPE_PROTECTED and rely on applied_operation_id dedupe."
        )
        conn.close()


class TestDedupeProtected:
    """Non-idempotent appliers protected by ``applied_operation_id`` dedupe."""

    @pytest.mark.parametrize("op_type", sorted(DEDUPE_PROTECTED))
    def test_raw_double_apply_changes_state(self, op_type: str) -> None:
        """Proves the harness detects non-idempotency for this bucket."""
        operations = _build_operation_chain(op_type)
        target = operations[-1]
        conn = _new_derived_conn()
        for operation in operations:
            apply_operation(conn, operation)
        conn.commit()
        before = _snapshot_database(conn)

        apply_operation(conn, target)
        conn.commit()
        after = _snapshot_database(conn)

        assert before != after, (
            f"{op_type} is classified DEDUPE_PROTECTED but its applier is "
            "idempotent; move it to IDEMPOTENT_BY_DESIGN."
        )
        conn.close()

    @pytest.mark.parametrize("op_type", sorted(DEDUPE_PROTECTED))
    async def test_sync_dedupes_duplicate_delivery(self, op_type: str) -> None:
        """Replaying the same envelope through ``WorkspaceStore.sync()`` twice
        must leave derived state unchanged thanks to ``applied_operation_id``."""
        operations = _build_operation_chain(op_type)
        relay = _FakeRelayStorage()
        for operation in operations:
            relay.save_envelope(_to_envelope(operation))

        store = WorkspaceStore(
            workspace_id="ws-1",
            actor_id="actor-1",
            relay_storage=relay,  # type: ignore[arg-type]
            db_path=":memory:",
            key_storage=_FixedKeyStorage(),  # type: ignore[arg-type]
        )
        await store.sync()
        conn = await store.get_db()
        first = _snapshot_database(conn)

        await store.sync()
        second = _snapshot_database(conn)

        assert first == second, (
            f"{op_type}: duplicate delivery through sync() changed derived state; "
            "the applied_operation_id dedupe is not protecting this applier."
        )
        if op_type == "link.click":
            row = conn.execute(
                "SELECT click_count FROM node_link WHERE source_id = ? AND target_id = ?",
                ("node-1", "node-2"),
            ).fetchone()
            assert row["click_count"] == 1
        await store.close()
        relay.close()


class TestNoBackendApplier:
    """Op types without a backend applier must fail loudly, not silently."""

    @pytest.mark.parametrize("op_type", sorted(NO_BACKEND_APPLIER))
    def test_apply_operation_rejects_unsupported_op_type(self, op_type: str) -> None:
        conn = _new_derived_conn()
        target = _build_operation_chain(op_type)[-1]
        with pytest.raises(ValueError, match="Unsupported op_type"):
            apply_operation(conn, target)
        conn.close()


class TestFlashcardReplayDeterminism:
    """Flashcard appliers stamp ``created_at``/``updated_at`` from the
    operation's envelope timestamp (not the wall clock), so replaying the same
    operation log always produces identical derived state."""

    def test_flashcard_create_stamps_envelope_timestamp(self) -> None:
        op = make_operation(
            "plugin.op",
            {
                "pluginId": flashcard_module.PLUGIN_ID,
                "opType": flashcard_module.OP_CREATE,
                "nodeId": "card-1",
                "data": {
                    "workspaceId": "ws-1",
                    "actorId": "actor-1",
                    "frontText": "front",
                    "backText": "back",
                },
            },
        )
        conn = _new_derived_conn()
        apply_operation(conn, op)
        apply_operation(conn, op)  # replay must not rewrite timestamps

        row = conn.execute(
            "SELECT created_at, updated_at FROM flashcard WHERE node_id = ?",
            ("card-1",),
        ).fetchone()
        expected = op.envelope.timestamp.isoformat()
        assert row["created_at"] == expected
        assert row["updated_at"] == expected
        conn.close()

    def test_flashcard_review_stamps_envelope_timestamp(self) -> None:
        conn = _new_derived_conn()
        apply_operation(
            conn,
            make_operation(
                "plugin.op",
                {
                    "pluginId": flashcard_module.PLUGIN_ID,
                    "opType": flashcard_module.OP_CREATE,
                    "nodeId": "card-1",
                    "data": {"workspaceId": "ws-1", "actorId": "actor-1"},
                },
            ),
        )
        review = make_operation(
            "plugin.op",
            {
                "pluginId": flashcard_module.PLUGIN_ID,
                "opType": flashcard_module.OP_REVIEW,
                "nodeId": "card-1",
                "data": {"easeFactor": 2.6, "intervalDays": 1, "repetitions": 1},
            },
        )
        apply_operation(conn, review)
        apply_operation(conn, review)  # replay must not rewrite updated_at

        row = conn.execute(
            "SELECT updated_at FROM flashcard WHERE node_id = ?",
            ("card-1",),
        ).fetchone()
        assert row["updated_at"] == review.envelope.timestamp.isoformat()
        conn.close()
