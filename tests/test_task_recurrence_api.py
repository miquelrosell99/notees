"""HTTP-level tests for task recurrence and completion endpoints."""

import pytest

from app.db.schema.constants import SYSTEM_CLASS_UUIDS

pytestmark = pytest.mark.asyncio


async def _get_class_id(client, uuid: str) -> int:
    r = await client.get("/api/nodes/classes")
    assert r.status_code == 200, r.text
    for node in r.json()["nodes"]:
        if node["uuid"] == uuid:
            return node["id"]
    raise RuntimeError(f"class {uuid} not found")


async def _create_task_node(client, page_class_id: int, task_class_id: int, name: str = "Task") -> int:
    r = await client.post("/api/nodes/", json={"name": name, "classes": [page_class_id, task_class_id]})
    assert r.status_code == 200, r.text
    return r.json()["id"]


async def test_recurrence_crud(authenticated_client, test_user):
    page_class_id = test_user["page_class_id"]
    task_class_id = await _get_class_id(authenticated_client, SYSTEM_CLASS_UUIDS["task"])
    node_id = await _create_task_node(authenticated_client, page_class_id, task_class_id)

    # Initially no rule
    r = await authenticated_client.get(f"/api/tasks/{node_id}/recurrence")
    assert r.status_code == 200
    assert r.json() is None

    # Create a weekly rule
    r = await authenticated_client.put(
        f"/api/tasks/{node_id}/recurrence",
        json={"rule_type": "weekly", "interval": 1, "weekdays": [1, 4], "active": True},
    )
    assert r.status_code == 200, r.text
    data = r.json()
    assert data["rule_type"] == "weekly"
    assert data["interval"] == 1
    assert data["weekdays"] == [1, 4]
    assert "Weekly" in data["description"]

    # Read back
    r = await authenticated_client.get(f"/api/tasks/{node_id}/recurrence")
    assert r.status_code == 200
    assert r.json()["rule_type"] == "weekly"

    # Delete
    r = await authenticated_client.delete(f"/api/tasks/{node_id}/recurrence")
    assert r.status_code == 200
    assert r.json()["deleted"] is True

    r = await authenticated_client.get(f"/api/tasks/{node_id}/recurrence")
    assert r.json() is None


async def test_completion_crud(authenticated_client, test_user):
    page_class_id = test_user["page_class_id"]
    task_class_id = await _get_class_id(authenticated_client, SYSTEM_CLASS_UUIDS["task"])
    node_id = await _create_task_node(authenticated_client, page_class_id, task_class_id)

    r = await authenticated_client.get(f"/api/tasks/{node_id}/completions")
    assert r.status_code == 200
    assert r.json() == []

    r = await authenticated_client.post(
        f"/api/tasks/{node_id}/completions",
        json={"status": "done", "scheduled_date": "2026-01-15"},
    )
    assert r.status_code == 200, r.text
    data = r.json()
    assert data["status"] == "done"
    assert data["scheduled_date"] == "2026-01-15"

    r = await authenticated_client.get(f"/api/tasks/{node_id}/completions")
    assert r.status_code == 200
    completions = r.json()
    assert len(completions) == 1

    completion_id = completions[0]["id"]
    r = await authenticated_client.delete(f"/api/tasks/{node_id}/completions/{completion_id}")
    assert r.status_code == 200
    assert r.json()["deleted"] is True

    r = await authenticated_client.get(f"/api/tasks/{node_id}/completions")
    assert r.json() == []


async def test_recurrence_rejects_non_task(authenticated_client, test_user):
    page_class_id = test_user["page_class_id"]
    r = await authenticated_client.post("/api/nodes/", json={"name": "Not a task", "classes": [page_class_id]})
    assert r.status_code == 200, r.text
    node_id = r.json()["id"]

    r = await authenticated_client.put(
        f"/api/tasks/{node_id}/recurrence",
        json={"rule_type": "daily", "interval": 1},
    )
    assert r.status_code == 400
