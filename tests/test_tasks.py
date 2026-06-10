"""Tests for the tasks list endpoint.

Tests GET /api/nodes/tasks
"""
import pytest
from httpx import AsyncClient

from app.db.schema import SYSTEM_CLASS_UUIDS, SYSTEM_PROPERTY_UUIDS


async def _get_task_class_id(authenticated_client: AsyncClient) -> int:
    """Look up the task system class node ID."""
    resp = await authenticated_client.get("/api/nodes/classes")
    assert resp.status_code == 200
    classes = resp.json().get("nodes", [])
    for cls in classes:
        if cls.get("uuid") == SYSTEM_CLASS_UUIDS["task"]:
            return cls["id"]
    pytest.fail("Task system class not found in workspace")


async def _get_task_status_property_id(authenticated_client: AsyncClient) -> int:
    """Look up the task_status property ID."""
    resp = await authenticated_client.get("/api/properties/")
    assert resp.status_code == 200
    properties = resp.json().get("properties", [])
    for prop in properties:
        if prop.get("uuid") == SYSTEM_PROPERTY_UUIDS["task_status"]:
            return prop["id"]
    pytest.fail("task_status property not found in workspace")


async def _create_node(authenticated_client: AsyncClient, **kwargs) -> dict:
    """Create a node via POST /api/nodes/."""
    resp = await authenticated_client.post("/api/nodes/", json=kwargs)
    assert resp.status_code == 200, f"create_node failed: {resp.text}"
    return resp.json()


async def _create_task_page(authenticated_client: AsyncClient, name: str) -> dict:
    """Create a node and assign the task class to it."""
    node = await _create_node(authenticated_client, name=name)
    task_class_id = await _get_task_class_id(authenticated_client)
    resp = await authenticated_client.post(
        f"/api/nodes/{node['id']}/classes",
        json={"class_node_id": task_class_id},
    )
    assert resp.status_code == 200, resp.text
    return resp.json()


async def _set_task_status(
    authenticated_client: AsyncClient, node_id: int, status_name: str
) -> None:
    """Set a task's status to a named option (e.g., 'Done', 'Cancelled')."""
    prop_id = await _get_task_status_property_id(authenticated_client)
    # Get selection lines for this property
    resp = await authenticated_client.get(f"/api/properties/{prop_id}")
    assert resp.status_code == 200
    prop_data = resp.json()
    lines = prop_data.get("options", [])
    line_id = None
    for line in lines:
        if line.get("name") == status_name:
            line_id = line["id"]
            break
    if line_id is None:
        pytest.fail(f"Status option '{status_name}' not found")

    resp = await authenticated_client.post(
        f"/api/nodes/{node_id}/properties/{prop_id}/selection",
        json={"selection_line_id": line_id},
    )
    assert resp.status_code == 200, resp.text


class TestListTasks:
    """Tests for GET /api/nodes/tasks"""

    @pytest.mark.asyncio
    async def test_returns_empty_list_initially(self, authenticated_client: AsyncClient):
        resp = await authenticated_client.get("/api/nodes/tasks")
        assert resp.status_code == 200
        data = resp.json()
        assert "items" in data
        assert isinstance(data["items"], list)
        assert data["items"] == []

    @pytest.mark.asyncio
    async def test_returns_tasks_after_creation(self, authenticated_client: AsyncClient):
        task = await _create_task_page(authenticated_client, "My Task")

        resp = await authenticated_client.get("/api/nodes/tasks")
        assert resp.status_code == 200
        data = resp.json()
        assert len(data["items"]) == 1
        assert data["items"][0]["id"] == task["id"]

    @pytest.mark.asyncio
    async def test_non_task_pages_not_listed(self, authenticated_client: AsyncClient):
        await _create_node(authenticated_client, name="Plain Page")
        await _create_task_page(authenticated_client, "Task One")

        resp = await authenticated_client.get("/api/nodes/tasks")
        assert resp.status_code == 200
        data = resp.json()
        assert len(data["nodes"]) == 1

    @pytest.mark.asyncio
    async def test_excludes_completed_tasks_by_default(self, authenticated_client: AsyncClient):
        task = await _create_task_page(authenticated_client, "Completed Task")
        await _set_task_status(authenticated_client, task["id"], "Done")

        resp = await authenticated_client.get("/api/nodes/tasks")
        assert resp.status_code == 200
        data = resp.json()
        assert len(data["nodes"]) == 0

    @pytest.mark.asyncio
    async def test_includes_completed_tasks_when_requested(self, authenticated_client: AsyncClient):
        task = await _create_task_page(authenticated_client, "Completed Task")
        await _set_task_status(authenticated_client, task["id"], "Done")

        resp = await authenticated_client.get("/api/nodes/tasks?include_complete=true")
        assert resp.status_code == 200
        data = resp.json()
        assert len(data["items"]) == 1
        assert data["items"][0]["id"] == task["id"]

    @pytest.mark.asyncio
    async def test_excludes_cancelled_tasks_by_default(self, authenticated_client: AsyncClient):
        task = await _create_task_page(authenticated_client, "Cancelled Task")
        await _set_task_status(authenticated_client, task["id"], "Cancelled")

        resp = await authenticated_client.get("/api/nodes/tasks")
        assert resp.status_code == 200
        data = resp.json()
        assert len(data["nodes"]) == 0

    @pytest.mark.asyncio
    async def test_pending_tasks_are_included(self, authenticated_client: AsyncClient):
        task = await _create_task_page(authenticated_client, "Pending Task")
        # Default status is "Pending" — no need to set it

        resp = await authenticated_client.get("/api/nodes/tasks")
        assert resp.status_code == 200
        data = resp.json()
        assert len(data["items"]) == 1
        assert data["items"][0]["id"] == task["id"]
