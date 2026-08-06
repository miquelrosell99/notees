"""Tests for the node_link UUID normalization and payload repair migrations."""

from __future__ import annotations

from typing import Any
from uuid import uuid4

import pytest

from app.db.migrations.normalize_node_link_uuids import run as normalize_run
from app.db.migrations.repair_node_link_payload_strings import run as repair_run


class _FakeRecord:
    """Minimal asyncpg.Record stand-in."""

    def __init__(self, data: dict[str, Any]) -> None:
        self._data = data

    def __getitem__(self, key: str) -> Any:
        return self._data[key]


class _FakeConnection:
    """In-memory asyncpg connection that records queries and parameters."""

    def __init__(self, rows: list[dict[str, Any]] | None = None) -> None:
        self._rows = [_FakeRecord(row) for row in (rows or [])]
        self.queries: list[tuple[str, tuple[Any, ...]]] = []

    async def fetch(self, query: str, *args: Any) -> list[_FakeRecord]:
        return list(self._rows)

    async def execute(self, query: str, *args: Any) -> str:
        self.queries.append((query, args))
        return "UPDATE 1"


@pytest.mark.unit
async def test_normalize_migration_writes_payload_as_dict() -> None:
    """Bare-target link_ids get a linkUuid and payload is written as jsonb dict."""
    source_id = str(uuid4())
    target_id = str(uuid4())
    op_id = str(uuid4())
    payload = {
        "nodeId": source_id,
        "content": [
            {
                "type": "paragraph",
                "children": [
                    {"type": "node_link", "link_id": target_id, "ref_type": "node"}
                ],
            }
        ],
    }
    conn = _FakeConnection([{"id": op_id, "op_type": "node.updateContent", "payload": payload}])

    updated = await normalize_run(conn)

    assert updated == 1
    assert len(conn.queries) == 1
    query, params = conn.queries[0]
    assert "UPDATE relay_envelope" in query
    updated_payload = params[0]
    assert isinstance(updated_payload, dict)
    link_id = updated_payload["content"][0]["children"][0]["link_id"]
    assert ":" in link_id
    assert link_id.startswith(target_id)


@pytest.mark.unit
async def test_normalize_migration_skips_already_qualified_links() -> None:
    """Links that already have targetUuid:linkUuid are left untouched."""
    source_id = str(uuid4())
    target_id = str(uuid4())
    link_uuid = str(uuid4())
    op_id = str(uuid4())
    payload = {
        "nodeId": source_id,
        "content": [
            {
                "type": "paragraph",
                "children": [
                    {
                        "type": "node_link",
                        "link_id": f"{target_id}:{link_uuid}",
                        "ref_type": "node",
                    }
                ],
            }
        ],
    }
    conn = _FakeConnection([{"id": op_id, "op_type": "node.updateContent", "payload": payload}])

    updated = await normalize_run(conn)

    assert updated == 0
    assert len(conn.queries) == 0


@pytest.mark.unit
async def test_normalize_migration_does_not_json_dump_payload() -> None:
    """The migration must not pass json.dumps(payload) to PostgreSQL."""
    source_id = str(uuid4())
    target_id = str(uuid4())
    op_id = str(uuid4())
    payload = {
        "nodeId": source_id,
        "content": [
            {"type": "node_link", "link_id": target_id, "ref_type": "node"}
        ],
    }
    conn = _FakeConnection([{"id": op_id, "op_type": "node.create", "payload": payload}])

    await normalize_run(conn)

    _query, params = conn.queries[0]
    assert not any(
        isinstance(param, str) and param.startswith("{")
        for param in params
    ), "payload was serialized to a JSON string instead of a dict"


@pytest.mark.unit
async def test_repair_migration_runs_string_to_object_update() -> None:
    """The repair migration executes SQL that re-parses string-typed jsonb payloads."""
    conn = _FakeConnection()

    updated = await repair_run(conn)

    assert updated == 1
    assert len(conn.queries) == 1
    query, _params = conn.queries[0]
    assert "jsonb_typeof(payload) = 'string'" in query
    assert "payload #>> '{}'" in query
    assert "::jsonb" in query
