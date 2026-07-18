"""Integration tests for the tasks router ported to WorkspaceStore."""

from __future__ import annotations

from collections.abc import AsyncGenerator
from datetime import UTC, datetime

import pytest
import pytest_asyncio
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient

from app.core.workspace_store import WorkspaceStore
from app.dependencies import (
    get_current_user,
    require_read_or_write_scope,
    require_write_scope,
)
from app.domain.entities.constants import SYSTEM_CLASS_UUIDS
from app.features.tasks.dependencies import get_workspace_store
from app.features.tasks.router import router as tasks_router
from app.models import User
from app.relay.storage import SqliteRelayStorage

pytestmark = pytest.mark.unit


class FixedKeyStorage:
    """In-memory key storage that returns a fixed 32-byte master key."""

    async def get_or_create_master_key(
        self, workspace_id: str, secret_key: str
    ) -> bytes:
        return b"0" * 32


async def _make_test_store(
    workspace_id: str = "ws-uuid-1",
    actor_id: str = "actor-1",
) -> WorkspaceStore:
    return WorkspaceStore(
        workspace_id=workspace_id,
        actor_id=actor_id,
        relay_storage=SqliteRelayStorage(":memory:"),
        db_path=":memory:",
        key_storage=FixedKeyStorage(),
    )


@pytest_asyncio.fixture
async def tasks_client() -> AsyncGenerator[AsyncClient, None]:
    """Authenticated test client with the tasks store dependency overridden."""
    store = await _make_test_store()

    async def _override_get_workspace_store() -> AsyncGenerator[WorkspaceStore, None]:
        try:
            yield store
        finally:
            await store.close()

    async def _override_get_current_user() -> User:
        return User(
            id="1",
            uuid="user-uuid-1",
            email="test@example.com",
            role="user",
            created_at=datetime.now(UTC),
        )

    async def _override_require_scope() -> User:
        return await _override_get_current_user()

    test_app = FastAPI()
    test_app.include_router(tasks_router)
    test_app.dependency_overrides[get_workspace_store] = _override_get_workspace_store
    test_app.dependency_overrides[get_current_user] = _override_get_current_user
    test_app.dependency_overrides[require_read_or_write_scope] = _override_require_scope
    test_app.dependency_overrides[require_write_scope] = _override_require_scope

    transport = ASGITransport(app=test_app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        client._tasks_test_store = store  # type: ignore[attr-defined]
        yield client


def _store(client: AsyncClient) -> WorkspaceStore:
    """Return the test WorkspaceStore attached to the client."""
    return client._tasks_test_store  # type: ignore[no-any-return,attr-defined]


async def _make_task_node(store: WorkspaceStore, node_uuid: str) -> None:
    """Create a block node with the task class in the derived store."""
    await store.create_node(
        node_uuid,
        "block",
        class_ids=[SYSTEM_CLASS_UUIDS["task"]],
    )
    await store.sync()


class TestRecurrence:
    async def test_get_recurrence_empty(self, tasks_client: AsyncClient) -> None:
        store = _store(tasks_client)
        await _make_task_node(store, "task-uuid-1")

        response = await tasks_client.get("/tasks/task-uuid-1/recurrence")
        assert response.status_code == 200
        assert response.json() is None

    async def test_set_and_get_recurrence_rule(self, tasks_client: AsyncClient) -> None:
        store = _store(tasks_client)
        await _make_task_node(store, "task-uuid-1")

        response = await tasks_client.put(
            "/tasks/task-uuid-1/recurrence",
            json={
                "rule_type": "weekly",
                "interval": 2,
                "weekdays": [1, 5],
                "active": True,
            },
        )
        assert response.status_code == 200
        body = response.json()
        assert body["task_node_uuid"] == "task-uuid-1"
        assert body["rule_type"] == "weekly"
        assert body["interval"] == 2
        assert body["weekdays"] == [1, 5]
        assert body["active"] is True
        assert "recurrence_uuid" in body
        assert "id" not in body
        assert "task_node_id" not in body

        get_response = await tasks_client.get("/tasks/task-uuid-1/recurrence")
        assert get_response.status_code == 200
        get_body = get_response.json()
        assert get_body["recurrence_uuid"] == body["recurrence_uuid"]
        assert "Every 2 week(s)" in get_body["description"]

    async def test_set_recurrence_rejects_non_task(self, tasks_client: AsyncClient) -> None:
        store = _store(tasks_client)
        await store.create_node("page-uuid-1", "page")
        await store.sync()

        response = await tasks_client.put(
            "/tasks/page-uuid-1/recurrence",
            json={"rule_type": "daily"},
        )
        assert response.status_code == 400

    async def test_delete_recurrence_rule(self, tasks_client: AsyncClient) -> None:
        store = _store(tasks_client)
        await _make_task_node(store, "task-uuid-1")

        await tasks_client.put(
            "/tasks/task-uuid-1/recurrence",
            json={"rule_type": "daily"},
        )

        delete_response = await tasks_client.delete("/tasks/task-uuid-1/recurrence")
        assert delete_response.status_code == 200
        assert delete_response.json() == {"deleted": True}

        get_response = await tasks_client.get("/tasks/task-uuid-1/recurrence")
        assert get_response.status_code == 200
        assert get_response.json() is None

    async def test_delete_recurrence_not_found(self, tasks_client: AsyncClient) -> None:
        store = _store(tasks_client)
        await _make_task_node(store, "task-uuid-1")

        response = await tasks_client.delete("/tasks/task-uuid-1/recurrence")
        assert response.status_code == 404


class TestCompletions:
    async def test_list_completions_empty(self, tasks_client: AsyncClient) -> None:
        store = _store(tasks_client)
        await _make_task_node(store, "task-uuid-1")

        response = await tasks_client.get("/tasks/task-uuid-1/completions")
        assert response.status_code == 200
        assert response.json() == []

    async def test_record_and_list_completion(self, tasks_client: AsyncClient) -> None:
        store = _store(tasks_client)
        await _make_task_node(store, "task-uuid-1")

        response = await tasks_client.post(
            "/tasks/task-uuid-1/completions",
            json={
                "scheduled_date": "2026-07-18",
                "deadline_date": "2026-07-19",
                "status": "done",
            },
        )
        assert response.status_code == 200
        body = response.json()
        assert body["task_node_uuid"] == "task-uuid-1"
        assert body["status"] == "done"
        assert body["scheduled_date"] == "2026-07-18"
        assert body["deadline_date"] == "2026-07-19"
        assert body["completed_by"] == "user-uuid-1"
        assert "completion_uuid" in body
        assert "id" not in body
        assert "task_node_id" not in body

        list_response = await tasks_client.get("/tasks/task-uuid-1/completions")
        assert list_response.status_code == 200
        rows = list_response.json()
        assert len(rows) == 1
        assert rows[0]["completion_uuid"] == body["completion_uuid"]

    async def test_record_completion_rejects_non_task(self, tasks_client: AsyncClient) -> None:
        store = _store(tasks_client)
        await store.create_node("page-uuid-1", "page")
        await store.sync()

        response = await tasks_client.post(
            "/tasks/page-uuid-1/completions",
            json={"status": "done"},
        )
        assert response.status_code == 400

    async def test_delete_completion(self, tasks_client: AsyncClient) -> None:
        store = _store(tasks_client)
        await _make_task_node(store, "task-uuid-1")

        create_response = await tasks_client.post(
            "/tasks/task-uuid-1/completions",
            json={"status": "skipped"},
        )
        completion_uuid = create_response.json()["completion_uuid"]

        delete_response = await tasks_client.delete(
            f"/tasks/task-uuid-1/completions/{completion_uuid}"
        )
        assert delete_response.status_code == 200
        assert delete_response.json() == {"deleted": True}

        list_response = await tasks_client.get("/tasks/task-uuid-1/completions")
        assert list_response.json() == []

    async def test_delete_completion_not_found(self, tasks_client: AsyncClient) -> None:
        store = _store(tasks_client)
        await _make_task_node(store, "task-uuid-1")

        response = await tasks_client.delete(
            "/tasks/task-uuid-1/completions/missing-uuid"
        )
        assert response.status_code == 404

    async def test_completion_pagination(self, tasks_client: AsyncClient) -> None:
        store = _store(tasks_client)
        await _make_task_node(store, "task-uuid-1")

        for i in range(3):
            await store.record_task_completion(
                completion_id=f"completion-{i}",
                node_id="task-uuid-1",
                completed_at=f"2026-07-{10 + i}T00:00:00Z",
                status="done",
            )
        await store.sync()

        response = await tasks_client.get("/tasks/task-uuid-1/completions?limit=2&offset=1")
        assert response.status_code == 200
        rows = response.json()
        assert len(rows) == 2
        assert rows[0]["completion_uuid"] == "completion-1"
