"""Tests for the tasks list endpoint.

Tests GET /api/nodes/tasks
"""
import pytest
from httpx import AsyncClient

from app.db.schema import SYSTEM_CLASS_UUIDS, SYSTEM_PROPERTY_UUIDS

pytestmark = pytest.mark.integration


async def _get_task_class_id(authenticated_client: AsyncClient) -> int:
    """Look up the task system class node ID."""
    resp = await authenticated_client.get("/api/nodes/classes")
    assert resp.status_code == 200
    classes = resp.json().get("nodes", [])
    for cls in classes:
        if cls.get("uuid") == SYSTEM_CLASS_UUIDS["task"]:
            return cls["id"]
    pytest.fail("Task system class not found in workspace")


async def _get_task_class_uuid(authenticated_client: AsyncClient) -> str:
    """Look up the task system class node UUID."""
    resp = await authenticated_client.get("/api/nodes/classes")
    assert resp.status_code == 200
    classes = resp.json().get("nodes", [])
    for cls in classes:
        if cls.get("uuid") == SYSTEM_CLASS_UUIDS["task"]:
            return cls["uuid"]
    pytest.fail("Task system class not found in workspace")


async def _get_task_status_property_uuid(authenticated_client: AsyncClient) -> str:
    """Look up the task_status property UUID."""
    resp = await authenticated_client.get("/api/properties/")
    assert resp.status_code == 200
    properties = resp.json().get("properties", [])
    for prop in properties:
        if prop.get("uuid") == SYSTEM_PROPERTY_UUIDS["task_status"]:
            return prop["uuid"]
    pytest.fail("task_status property not found in workspace")


async def _create_node(authenticated_client: AsyncClient, **kwargs) -> dict:
    """Create a node via POST /api/nodes/."""
    resp = await authenticated_client.post("/api/nodes/", json=kwargs)
    assert resp.status_code == 200, f"create_node failed: {resp.text}"
    return resp.json()


async def _create_task_page(authenticated_client: AsyncClient, name: str) -> dict:
    """Create a node and assign the task class to it."""
    node = await _create_node(authenticated_client, name=name)
    task_class_uuid = await _get_task_class_uuid(authenticated_client)
    resp = await authenticated_client.post(
        f"/api/nodes/{node['uuid']}/classes",
        json={"class_node_uuid": task_class_uuid},
    )
    assert resp.status_code == 200, resp.text
    return resp.json()


async def _set_task_status(
    authenticated_client: AsyncClient, node_uuid: str, status_name: str
) -> None:
    """Set a task's status to a named option (e.g., 'Done', 'Cancelled')."""
    prop_uuid = await _get_task_status_property_uuid(authenticated_client)
    # Get selection lines for this property
    resp = await authenticated_client.get(f"/api/properties/{prop_uuid}")
    assert resp.status_code == 200
    prop_data = resp.json()
    lines = prop_data.get("options", [])
    line_uuid = None
    for line in lines:
        if line.get("name") == status_name:
            line_uuid = line["uuid"]
            break
    if line_uuid is None:
        pytest.fail(f"Status option '{status_name}' not found")

    resp = await authenticated_client.post(
        f"/api/nodes/{node_uuid}/properties/{prop_uuid}/selection",
        json={"selection_line_uuid": line_uuid},
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
        assert len(data["items"]) == 1

    @pytest.mark.asyncio
    async def test_excludes_completed_tasks_by_default(self, authenticated_client: AsyncClient):
        task = await _create_task_page(authenticated_client, "Completed Task")
        await _set_task_status(authenticated_client, task["uuid"], "Done")

        resp = await authenticated_client.get("/api/nodes/tasks")
        assert resp.status_code == 200
        data = resp.json()
        assert len(data["items"]) == 0

    @pytest.mark.asyncio
    async def test_includes_completed_tasks_when_requested(self, authenticated_client: AsyncClient):
        task = await _create_task_page(authenticated_client, "Completed Task")
        await _set_task_status(authenticated_client, task["uuid"], "Done")

        resp = await authenticated_client.get("/api/nodes/tasks?include_complete=true")
        assert resp.status_code == 200
        data = resp.json()
        assert len(data["items"]) == 1
        assert data["items"][0]["id"] == task["id"]

    @pytest.mark.asyncio
    async def test_excludes_cancelled_tasks_by_default(self, authenticated_client: AsyncClient):
        task = await _create_task_page(authenticated_client, "Cancelled Task")
        await _set_task_status(authenticated_client, task["uuid"], "Cancelled")

        resp = await authenticated_client.get("/api/nodes/tasks")
        assert resp.status_code == 200
        data = resp.json()
        assert len(data["items"]) == 0

    @pytest.mark.asyncio
    async def test_pending_tasks_are_included(self, authenticated_client: AsyncClient):
        task = await _create_task_page(authenticated_client, "Pending Task")
        # Default status is "Pending" — no need to set it

        resp = await authenticated_client.get("/api/nodes/tasks")
        assert resp.status_code == 200
        data = resp.json()
        assert len(data["items"]) == 1
        assert data["items"][0]["id"] == task["id"]


class TestIsTaskFlag:
    """Tests that node.is_task stays synchronized with the task class assignment."""

    @pytest.mark.asyncio
    async def test_is_task_set_on_creation_with_task_class(
        self, authenticated_client: AsyncClient
    ):
        task_class_uuid = await _get_task_class_uuid(authenticated_client)
        task = await _create_node(
            authenticated_client, name="Task on Create", class_uuids=[task_class_uuid]
        )
        assert task.get("is_task") is True

        resp = await authenticated_client.get(f"/api/nodes/{task['uuid']}")
        assert resp.status_code == 200
        assert resp.json().get("is_task") is True

    @pytest.mark.asyncio
    async def test_is_task_false_without_task_class(
        self, authenticated_client: AsyncClient
    ):
        page = await _create_node(authenticated_client, name="Plain Page")
        assert page.get("is_task") is False

    @pytest.mark.asyncio
    async def test_is_task_set_when_adding_task_class(
        self, authenticated_client: AsyncClient
    ):
        page = await _create_node(authenticated_client, name="Becomes Task")
        assert page.get("is_task") is False

        task_class_uuid = await _get_task_class_uuid(authenticated_client)
        resp = await authenticated_client.post(
            f"/api/nodes/{page['uuid']}/classes",
            json={"class_node_uuid": task_class_uuid},
        )
        assert resp.status_code == 200
        assert resp.json().get("is_task") is True

    @pytest.mark.asyncio
    async def test_is_task_cleared_when_removing_task_class(
        self, authenticated_client: AsyncClient
    ):
        task_class_uuid = await _get_task_class_uuid(authenticated_client)
        task = await _create_node(
            authenticated_client, name="Former Task", class_uuids=[task_class_uuid]
        )
        assert task.get("is_task") is True

        resp = await authenticated_client.delete(
            f"/api/nodes/{task['uuid']}/classes/{task_class_uuid}"
        )
        assert resp.status_code == 200
        assert resp.json().get("is_task") is False
