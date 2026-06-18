"""Pure unit tests for TaskAutomationService using in-memory fakes."""

from __future__ import annotations

from datetime import date, timedelta
from types import SimpleNamespace

import pytest
import pytest_asyncio

from app.domain.entities import Node, NodeCreateData
from app.domain.entities.constants import SYSTEM_CLASS_UUIDS, SYSTEM_PROPERTY_UUIDS
from app.features.nodes.node_service import NodeService
from app.features.tasks.service import TaskAutomationService
from tests.fakes import (
    FakeClassExtendRepository,
    FakeLinkParsingService,
    FakeNodeRepository,
    FakePropertyRepository,
    FakeTaskCompletionRepository,
    FakeTaskRecurrenceRepository,
)

pytestmark = pytest.mark.unit


@pytest_asyncio.fixture
async def services():
    """Build NodeService + TaskAutomationService backed by in-memory fakes."""
    node_repo = FakeNodeRepository()
    page_class = node_repo.add_node(
        Node(uuid=SYSTEM_CLASS_UUIDS["page"], name="Page", is_page=True)
    )
    task_class = node_repo.add_node(
        Node(uuid=SYSTEM_CLASS_UUIDS["task"], name="Task", is_task=True)
    )
    node_repo.add_node(Node(uuid=SYSTEM_CLASS_UUIDS["day"], name="Day", is_day=True))

    property_repo = FakePropertyRepository()

    status_prop = await property_repo.get_by_uuid(
        SYSTEM_PROPERTY_UUIDS["task_status"]
    )
    for name in ("Backlog", "Pending", "Doing", "Reviewing", "Done", "Cancelled"):
        await property_repo.add_selection_line(status_prop.id, name)

    recurrence_prop = await property_repo.get_by_uuid(
        SYSTEM_PROPERTY_UUIDS["task_recurrence"]
    )
    for name in ("Daily", "Every Weekday", "Weekly", "Biweekly", "Monthly", "Yearly"):
        await property_repo.add_selection_line(recurrence_prop.id, name)

    link_service = FakeLinkParsingService()
    class_extend_repo = FakeClassExtendRepository()
    node_service = NodeService(
        node_repo,
        property_repo,
        link_service,
        page_class_id=page_class.id,
        workspace_id=1,
        class_extend_repo=class_extend_repo,
    )
    task_service = TaskAutomationService(
        node_service,
        property_repo,
        FakeTaskRecurrenceRepository(),
        FakeTaskCompletionRepository(),
        user_id=1,
    )
    return SimpleNamespace(
        node_service=node_service,
        task_service=task_service,
        property_repo=property_repo,
        page_class_id=page_class.id,
        task_class_id=task_class.id,
    )


async def _get_selection_line_id(property_repo, property_id, name):
    lines = await property_repo.get_selection_lines(property_id)
    for line in lines:
        if line.name == name:
            return line.id
    pytest.fail(f"Selection line '{name}' not found for property {property_id}")


def _uuid_to_date(uuid_str: str) -> date | None:
    """Extract a date from a day page UUID."""
    try:
        parts = uuid_str.split("-")
        date_part = parts[4][:8]
        return date(
            int(date_part[:4]),
            int(date_part[4:6]),
            int(date_part[6:8]),
        )
    except (IndexError, ValueError):
        return None


@pytest.mark.asyncio
async def test_handle_status_change_sets_closed_date_when_done(services):
    """Setting a task to Done populates the closed date relation."""
    task = await services.node_service.create_raw_node(
        NodeCreateData(
            name="Task",
            classes=[services.page_class_id, services.task_class_id],
        )
    )

    status_prop = await services.property_repo.get_by_uuid(
        SYSTEM_PROPERTY_UUIDS["task_status"]
    )
    done_line_id = await _get_selection_line_id(
        services.property_repo, status_prop.id, "Done"
    )
    await services.task_service.handle_status_change(task.id, done_line_id)

    all_values = await services.property_repo.get_all_property_values(task.id)
    closed_prop = await services.property_repo.get_by_uuid(
        SYSTEM_PROPERTY_UUIDS["task_closed_date"]
    )
    assert closed_prop.id in all_values, "Closed Date property should have a value"
    closed_value = all_values[closed_prop.id]["values"][0]
    assert closed_value.target_id is not None


@pytest.mark.asyncio
async def test_handle_status_change_clears_closed_date_when_reopened(services):
    """Moving a task from a closed status to an open status clears closed date."""
    task = await services.node_service.create_raw_node(
        NodeCreateData(
            name="Task",
            classes=[services.page_class_id, services.task_class_id],
        )
    )

    status_prop = await services.property_repo.get_by_uuid(
        SYSTEM_PROPERTY_UUIDS["task_status"]
    )
    done_line_id = await _get_selection_line_id(
        services.property_repo, status_prop.id, "Done"
    )
    pending_line_id = await _get_selection_line_id(
        services.property_repo, status_prop.id, "Pending"
    )

    await services.task_service.handle_status_change(task.id, done_line_id)
    await services.task_service.handle_status_change(task.id, pending_line_id)

    all_values = await services.property_repo.get_all_property_values(task.id)
    closed_prop = await services.property_repo.get_by_uuid(
        SYSTEM_PROPERTY_UUIDS["task_closed_date"]
    )
    closed_values = all_values.get(closed_prop.id, {}).get("values", [])
    assert closed_values == [], "Closed Date should be cleared"


@pytest.mark.asyncio
async def test_recurrence_advances_dates(services):
    """Completing a recurring task advances the scheduled date and resets status."""
    task = await services.node_service.create_raw_node(
        NodeCreateData(
            name="Recurring Task",
            classes=[services.page_class_id, services.task_class_id],
        )
    )

    today = date.today()
    day_node = await services.node_service.get_or_create_day_node(today)
    assert day_node is not None

    scheduled_prop = await services.property_repo.get_by_uuid(
        SYSTEM_PROPERTY_UUIDS["task_scheduled"]
    )
    await services.property_repo.set_relation_value(
        task.id, scheduled_prop.id, day_node.id
    )

    recurrence_prop = await services.property_repo.get_by_uuid(
        SYSTEM_PROPERTY_UUIDS["task_recurrence"]
    )
    weekly_line_id = await _get_selection_line_id(
        services.property_repo, recurrence_prop.id, "Weekly"
    )
    await services.property_repo.set_selection_value(
        task.id, recurrence_prop.id, weekly_line_id
    )

    status_prop = await services.property_repo.get_by_uuid(
        SYSTEM_PROPERTY_UUIDS["task_status"]
    )
    done_line_id = await _get_selection_line_id(
        services.property_repo, status_prop.id, "Done"
    )
    await services.task_service.handle_status_change(task.id, done_line_id)

    all_values = await services.property_repo.get_all_property_values(task.id)

    scheduled_value = all_values[scheduled_prop.id]["values"][0]
    new_day_node = await services.node_service.get_node(scheduled_value.target_id)
    assert new_day_node is not None
    new_date = _uuid_to_date(new_day_node.uuid)
    assert new_date == today + timedelta(weeks=1)

    status_value = all_values[status_prop.id]["values"][0]
    pending_line_id = await _get_selection_line_id(
        services.property_repo, status_prop.id, "Pending"
    )
    assert status_value.selection_line_id == pending_line_id

    closed_prop = await services.property_repo.get_by_uuid(
        SYSTEM_PROPERTY_UUIDS["task_closed_date"]
    )
    closed_values = all_values.get(closed_prop.id, {}).get("values", [])
    assert closed_values == []
