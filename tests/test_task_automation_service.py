"""Domain-level tests for TaskAutomationService.

These tests verify task lifecycle side effects (closed date and recurrence)
directly through the domain service, without going through HTTP endpoints.
"""

from datetime import date, timedelta

import pytest
import pytest_asyncio

from app.db.schema.constants import SYSTEM_CLASS_UUIDS, SYSTEM_PROPERTY_UUIDS
from tests.fakes import FakeTaskCompletionRepository, FakeTaskRecurrenceRepository

pytestmark = pytest.mark.integration


async def _get_task_class_id(node_service) -> int:
    """Look up the task system class node ID."""
    node = await node_service.get_node_by_uuid(SYSTEM_CLASS_UUIDS["task"])
    assert node and node.id is not None
    return node.id


async def _get_property_id(property_repository, uuid: str) -> int:
    """Look up a system property ID by UUID."""
    prop = await property_repository.get_by_uuid(uuid)
    assert prop and prop.id is not None
    return prop.id


async def _get_selection_line_id(property_repository, property_id: int, name: str) -> int:
    """Look up a selection line ID by name."""
    lines = await property_repository.get_selection_lines(property_id)
    for line in lines:
        if line.name == name:
            assert line.id is not None
            return line.id
    pytest.fail(f"Selection line '{name}' not found for property {property_id}")


async def _create_task_node(node_service, property_repository, name: str = "Test Task"):
    """Create a node and assign the task class to it."""
    from app.domain.entities import NodeCreateData

    task_class_id = await _get_task_class_id(node_service)
    page_class_id = node_service.page_class_id
    assert page_class_id is not None

    node = await node_service.create_raw_node(
        NodeCreateData(name=name, classes=[page_class_id, task_class_id])
    )
    assert node.id is not None
    return node


async def _set_task_status(
    task_service, property_repository, node_id: int, status_name: str
) -> None:
    """Set a task's status and run task automations."""
    status_prop_id = await _get_property_id(
        property_repository, SYSTEM_PROPERTY_UUIDS["task_status"]
    )
    line_id = await _get_selection_line_id(
        property_repository, status_prop_id, status_name
    )
    await property_repository.set_selection_value(node_id, status_prop_id, line_id)
    await task_service.handle_status_change(node_id, line_id)


async def _get_node_properties_raw(property_repository, node_id: int) -> dict:
    """Return all property values for a node keyed by property UUID."""
    all_values = await property_repository.get_all_property_values(node_id)
    result: dict[str, dict | None] = {}
    for _prop_id, data in all_values.items():
        prop = data["property"]
        values = data["values"]
        if not values:
            result[prop.uuid] = None
            continue
        result[prop.uuid] = values[0]
    return result


@pytest_asyncio.fixture
async def task_automation_service(node_service, property_repository, test_user):
    """Create a TaskAutomationService for the test user's workspace."""
    from app.features.tasks.service import TaskAutomationService
    return TaskAutomationService(
        node_service,
        property_repository,
        FakeTaskRecurrenceRepository(),
        FakeTaskCompletionRepository(),
        user_id=int(test_user["id"]),
    )


class TestClosedDateAutomation:
    @pytest.mark.asyncio
    async def test_sets_closed_date_when_done(
        self, task_automation_service, node_service, property_repository
    ):
        task = await _create_task_node(node_service, property_repository)
        await _set_task_status(
            task_automation_service, property_repository, task.id, "Done"
        )

        props = await _get_node_properties_raw(property_repository, task.id)
        closed_value = props.get(SYSTEM_PROPERTY_UUIDS["task_closed_date"])
        assert closed_value is not None, "Closed Date should have a value"
        assert getattr(closed_value, "target_id", None) is not None

    @pytest.mark.asyncio
    async def test_sets_closed_date_when_cancelled(
        self, task_automation_service, node_service, property_repository
    ):
        task = await _create_task_node(node_service, property_repository)
        await _set_task_status(
            task_automation_service, property_repository, task.id, "Cancelled"
        )

        props = await _get_node_properties_raw(property_repository, task.id)
        closed_value = props.get(SYSTEM_PROPERTY_UUIDS["task_closed_date"])
        assert closed_value is not None, "Closed Date should have a value"

    @pytest.mark.asyncio
    async def test_clears_closed_date_when_reopened(
        self, task_automation_service, node_service, property_repository
    ):
        task = await _create_task_node(node_service, property_repository)
        await _set_task_status(
            task_automation_service, property_repository, task.id, "Done"
        )
        await _set_task_status(
            task_automation_service, property_repository, task.id, "Pending"
        )

        props = await _get_node_properties_raw(property_repository, task.id)
        closed_value = props.get(SYSTEM_PROPERTY_UUIDS["task_closed_date"])
        assert closed_value is None, "Closed Date should be cleared"


class TestRecurrenceAutomation:
    @pytest.mark.asyncio
    async def test_weekly_recurrence_advances_dates(
        self, task_automation_service, node_service, property_repository
    ):
        task = await _create_task_node(node_service, property_repository)

        today = date.today()
        day_node = await node_service.get_or_create_day_node(today)
        assert day_node.id is not None

        scheduled_prop_id = await _get_property_id(
            property_repository, SYSTEM_PROPERTY_UUIDS["task_scheduled"]
        )
        await property_repository.set_relation_value(
            task.id, scheduled_prop_id, day_node.id
        )

        recurrence_prop_id = await _get_property_id(
            property_repository, SYSTEM_PROPERTY_UUIDS["task_recurrence"]
        )
        weekly_line_id = await _get_selection_line_id(
            property_repository, recurrence_prop_id, "Weekly"
        )
        await property_repository.set_selection_value(
            task.id, recurrence_prop_id, weekly_line_id
        )

        await _set_task_status(
            task_automation_service, property_repository, task.id, "Done"
        )

        props = await _get_node_properties_raw(property_repository, task.id)

        # Status reset to Pending
        status_value = props.get(SYSTEM_PROPERTY_UUIDS["task_status"])
        assert status_value is not None
        pending_line_id = await _get_selection_line_id(
            property_repository,
            await _get_property_id(
                property_repository, SYSTEM_PROPERTY_UUIDS["task_status"]
            ),
            "Pending",
        )
        assert status_value.selection_line_id == pending_line_id

        # Scheduled date advanced by ~7 days
        scheduled_value = props.get(SYSTEM_PROPERTY_UUIDS["task_scheduled"])
        assert scheduled_value is not None
        new_target_id = getattr(scheduled_value, "target_id", None)
        assert new_target_id is not None
        assert new_target_id != day_node.id

        new_day_node = await node_service.get_node(new_target_id)
        assert new_day_node is not None
        new_date = _uuid_to_date(new_day_node.uuid)
        assert new_date == today + timedelta(weeks=1)

    @pytest.mark.asyncio
    async def test_recurrence_without_rule_does_nothing(
        self, task_automation_service, node_service, property_repository
    ):
        task = await _create_task_node(node_service, property_repository)
        await _set_task_status(
            task_automation_service, property_repository, task.id, "Done"
        )

        props = await _get_node_properties_raw(property_repository, task.id)
        status_value = props.get(SYSTEM_PROPERTY_UUIDS["task_status"])
        assert status_value is not None
        done_line_id = await _get_selection_line_id(
            property_repository,
            await _get_property_id(
                property_repository, SYSTEM_PROPERTY_UUIDS["task_status"]
            ),
            "Done",
        )
        assert status_value.selection_line_id == done_line_id

    @pytest.mark.asyncio
    async def test_monthly_recurrence_preserves_day_when_valid(
        self, task_automation_service, node_service, property_repository
    ):
        task = await _create_task_node(node_service, property_repository)

        # Start on the 15th of a month.
        start_date = date(2026, 1, 15)
        day_node = await node_service.get_or_create_day_node(start_date)
        assert day_node.id is not None

        scheduled_prop_id = await _get_property_id(
            property_repository, SYSTEM_PROPERTY_UUIDS["task_scheduled"]
        )
        await property_repository.set_relation_value(
            task.id, scheduled_prop_id, day_node.id
        )

        recurrence_prop_id = await _get_property_id(
            property_repository, SYSTEM_PROPERTY_UUIDS["task_recurrence"]
        )
        monthly_line_id = await _get_selection_line_id(
            property_repository, recurrence_prop_id, "Monthly"
        )
        await property_repository.set_selection_value(
            task.id, recurrence_prop_id, monthly_line_id
        )

        await _set_task_status(
            task_automation_service, property_repository, task.id, "Done"
        )

        scheduled_value = (
            await _get_node_properties_raw(property_repository, task.id)
        ).get(SYSTEM_PROPERTY_UUIDS["task_scheduled"])
        assert scheduled_value is not None
        new_target_id = getattr(scheduled_value, "target_id", None)
        new_day_node = await node_service.get_node(new_target_id)
        assert new_day_node is not None
        assert _uuid_to_date(new_day_node.uuid) == date(2026, 2, 15)

    @pytest.mark.asyncio
    async def test_monthly_recurrence_falls_back_to_last_day_of_month(
        self, task_automation_service, node_service, property_repository
    ):
        task = await _create_task_node(node_service, property_repository)

        # Start on January 31st; February has only 28 days in 2026.
        start_date = date(2026, 1, 31)
        day_node = await node_service.get_or_create_day_node(start_date)
        assert day_node.id is not None

        scheduled_prop_id = await _get_property_id(
            property_repository, SYSTEM_PROPERTY_UUIDS["task_scheduled"]
        )
        await property_repository.set_relation_value(
            task.id, scheduled_prop_id, day_node.id
        )

        recurrence_prop_id = await _get_property_id(
            property_repository, SYSTEM_PROPERTY_UUIDS["task_recurrence"]
        )
        monthly_line_id = await _get_selection_line_id(
            property_repository, recurrence_prop_id, "Monthly"
        )
        await property_repository.set_selection_value(
            task.id, recurrence_prop_id, monthly_line_id
        )

        await _set_task_status(
            task_automation_service, property_repository, task.id, "Done"
        )

        scheduled_value = (
            await _get_node_properties_raw(property_repository, task.id)
        ).get(SYSTEM_PROPERTY_UUIDS["task_scheduled"])
        assert scheduled_value is not None
        new_target_id = getattr(scheduled_value, "target_id", None)
        new_day_node = await node_service.get_node(new_target_id)
        assert new_day_node is not None
        assert _uuid_to_date(new_day_node.uuid) == date(2026, 2, 28)


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
