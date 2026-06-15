"""Tests for task automation handlers.

Covers:
- Closed Date auto-set/clear on status changes
- Recurrence date advancement and status reset
- Batch property endpoint triggering automations
"""

from datetime import date

import pytest
from httpx import AsyncClient

from app.db.schema import SYSTEM_CLASS_UUIDS, SYSTEM_PROPERTY_UUIDS


async def _get_task_class_id(authenticated_client: AsyncClient) -> int:
    resp = await authenticated_client.get("/api/nodes/classes")
    assert resp.status_code == 200
    classes = resp.json().get("nodes", [])
    for cls in classes:
        if cls.get("uuid") == SYSTEM_CLASS_UUIDS["task"]:
            return cls["id"]
    pytest.fail("Task system class not found")


async def _get_property_id(authenticated_client: AsyncClient, uuid: str) -> int:
    resp = await authenticated_client.get("/api/properties/")
    assert resp.status_code == 200
    properties = resp.json().get("properties", [])
    for prop in properties:
        if prop.get("uuid") == uuid:
            return prop["id"]
    pytest.fail(f"Property {uuid} not found")


async def _get_selection_line_id(
    authenticated_client: AsyncClient, property_id: int, name: str
) -> int:
    resp = await authenticated_client.get(f"/api/properties/{property_id}")
    assert resp.status_code == 200
    lines = resp.json().get("options", [])
    for line in lines:
        if line.get("name") == name:
            return line["id"]
    pytest.fail(f"Selection line '{name}' not found for property {property_id}")


async def _create_task_page(authenticated_client: AsyncClient, name: str) -> dict:
    resp = await authenticated_client.post("/api/nodes/", json={"name": name})
    assert resp.status_code == 200, resp.text
    node = resp.json()
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
    prop_id = await _get_property_id(
        authenticated_client, SYSTEM_PROPERTY_UUIDS["task_status"]
    )
    line_id = await _get_selection_line_id(authenticated_client, prop_id, status_name)
    # Use the generic property endpoint so automations fire
    resp = await authenticated_client.post(
        f"/api/nodes/{node_id}/properties",
        json={"property_id": prop_id, "value": line_id},
    )
    assert resp.status_code == 200, resp.text


async def _get_node_properties_raw(authenticated_client: AsyncClient, node_id: int) -> list[dict]:
    """Return the raw properties list from GET /api/nodes/{id}/properties."""
    resp = await authenticated_client.get(f"/api/nodes/{node_id}/properties")
    assert resp.status_code == 200, resp.text
    return resp.json().get("properties", [])


def _find_prop(props: list[dict], uuid: str) -> dict | None:
    for item in props:
        if item.get("property", {}).get("uuid") == uuid:
            return item
    return None


class TestClosedDateAutomation:
    @pytest.mark.asyncio
    async def test_sets_closed_date_when_done(self, authenticated_client: AsyncClient):
        task = await _create_task_page(authenticated_client, "Task Done")
        await _set_task_status(authenticated_client, task["id"], "Done")

        props = await _get_node_properties_raw(authenticated_client, task["id"])
        closed_item = _find_prop(props, SYSTEM_PROPERTY_UUIDS["task_closed_date"])
        assert closed_item is not None, "Closed Date property should be present"
        assert closed_item.get("values"), "Closed Date should have a value"

    @pytest.mark.asyncio
    async def test_sets_closed_date_when_cancelled(self, authenticated_client: AsyncClient):
        task = await _create_task_page(authenticated_client, "Task Cancelled")
        await _set_task_status(authenticated_client, task["id"], "Cancelled")

        props = await _get_node_properties_raw(authenticated_client, task["id"])
        closed_item = _find_prop(props, SYSTEM_PROPERTY_UUIDS["task_closed_date"])
        assert closed_item is not None, "Closed Date property should be present"
        assert closed_item.get("values"), "Closed Date should have a value"

    @pytest.mark.asyncio
    async def test_clears_closed_date_when_reopened(self, authenticated_client: AsyncClient):
        task = await _create_task_page(authenticated_client, "Task Reopened")
        await _set_task_status(authenticated_client, task["id"], "Done")
        await _set_task_status(authenticated_client, task["id"], "Pending")

        props = await _get_node_properties_raw(authenticated_client, task["id"])
        closed_item = _find_prop(props, SYSTEM_PROPERTY_UUIDS["task_closed_date"])
        # When cleared, the relation value should be absent or empty
        assert closed_item is None or not closed_item.get("values")


class TestRecurrenceAutomation:
    @pytest.mark.asyncio
    async def test_weekly_recurrence_advances_dates(self, authenticated_client: AsyncClient):
        task = await _create_task_page(authenticated_client, "Recurring Task")

        # Set a scheduled date (today)
        scheduled_prop_id = await _get_property_id(
            authenticated_client, SYSTEM_PROPERTY_UUIDS["task_scheduled"]
        )
        today = date.today()
        # Use the daily note endpoint to auto-create the day page
        resp = await authenticated_client.post(
            "/api/nodes/daily", params={"date": today.strftime("%Y-%m-%d")}
        )
        assert resp.status_code == 200, resp.text
        day_node = resp.json()

        await authenticated_client.post(
            f"/api/nodes/{task['id']}/properties/{scheduled_prop_id}/relation",
            json={"target_node_id": day_node["id"]},
        )

        # Set recurrence to Weekly
        recurrence_prop_id = await _get_property_id(
            authenticated_client, SYSTEM_PROPERTY_UUIDS["task_recurrence"]
        )
        weekly_line_id = await _get_selection_line_id(
            authenticated_client, recurrence_prop_id, "Weekly"
        )
        await authenticated_client.post(
            f"/api/nodes/{task['id']}/properties/{recurrence_prop_id}/selection",
            json={"selection_line_id": weekly_line_id},
        )

        # Complete the task
        await _set_task_status(authenticated_client, task["id"], "Done")

        # Verify status reset to Pending
        props = await _get_node_properties_raw(authenticated_client, task["id"])
        status_item = _find_prop(props, SYSTEM_PROPERTY_UUIDS["task_status"])
        assert status_item is not None
        status_line_id = status_item["values"][0]["selection_line_id"]
        pending_line_id = await _get_selection_line_id(
            authenticated_client,
            await _get_property_id(authenticated_client, SYSTEM_PROPERTY_UUIDS["task_status"]),
            "Pending",
        )
        assert status_line_id == pending_line_id

        # Verify scheduled date advanced by ~7 days
        scheduled_item = _find_prop(props, SYSTEM_PROPERTY_UUIDS["task_scheduled"])
        assert scheduled_item is not None
        assert scheduled_item.get("values"), "Scheduled date should have a value"
        new_target_id = scheduled_item["values"][0]["target_node_id"]
        assert new_target_id != day_node["id"]

    @pytest.mark.asyncio
    async def test_recurrence_without_rule_does_nothing(self, authenticated_client: AsyncClient):
        task = await _create_task_page(authenticated_client, "Non-Recurring Task")
        await _set_task_status(authenticated_client, task["id"], "Done")

        props = await _get_node_properties_raw(authenticated_client, task["id"])
        status_item = _find_prop(props, SYSTEM_PROPERTY_UUIDS["task_status"])
        assert status_item is not None
        status_line_id = status_item["values"][0]["selection_line_id"]
        done_line_id = await _get_selection_line_id(
            authenticated_client,
            await _get_property_id(authenticated_client, SYSTEM_PROPERTY_UUIDS["task_status"]),
            "Done",
        )
        assert status_line_id == done_line_id


class TestBatchEndpointAutomations:
    @pytest.mark.asyncio
    async def test_batch_status_triggers_closed_date(self, authenticated_client: AsyncClient):
        task = await _create_task_page(authenticated_client, "Batch Task")
        status_prop_id = await _get_property_id(
            authenticated_client, SYSTEM_PROPERTY_UUIDS["task_status"]
        )
        done_line_id = await _get_selection_line_id(
            authenticated_client, status_prop_id, "Done"
        )

        resp = await authenticated_client.post(
            "/api/nodes/batch/set",
            json={
                "items": [
                    {
                        "node_id": task["id"],
                        "property_id": status_prop_id,
                        "value": done_line_id,
                    }
                ]
            },
        )
        assert resp.status_code == 200, resp.text
        result = resp.json()
        assert result["succeeded"] == 1

        props = await _get_node_properties_raw(authenticated_client, task["id"])
        closed_item = _find_prop(props, SYSTEM_PROPERTY_UUIDS["task_closed_date"])
        assert closed_item is not None, "Closed Date property should be present"
        assert closed_item.get("values"), "Closed Date should have a value"
