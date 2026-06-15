"""Task automation service.

Encapsulates task lifecycle side effects (closed date and recurrence) that were
previously implemented directly in the properties router. Keeping this logic in
the domain layer preserves the hexagonal boundary and makes it testable without
HTTP scaffolding.
"""

from __future__ import annotations

from datetime import date
from typing import TYPE_CHECKING

from ...db.schema.constants import (
    SYSTEM_PROPERTY_UUIDS,
    TASK_CLOSED_STATUSES,
    TASK_DEFAULT_STATUS,
    TASK_RECURRENCE_OPTIONS,
)
from ..entities import Property, TaskCompletion, TaskRecurrence
from .recurrence_engine import has_ended, next_occurrence

if TYPE_CHECKING:
    from ..repositories.interfaces import (
        TaskCompletionRepository,
        TaskRecurrenceRepository,
    )
    from .node_service import NodeService


class TaskAutomationService:
    """Runs task lifecycle automations triggered by status changes."""

    def __init__(
        self,
        node_service: NodeService,
        recurrence_repo: TaskRecurrenceRepository,
        completion_repo: TaskCompletionRepository,
    ) -> None:
        self._node_service = node_service
        self._prop_repo = node_service.property_repo
        self._recurrence_repo = recurrence_repo
        self._completion_repo = completion_repo

    @property
    def node_service(self) -> NodeService:
        """Expose the underlying NodeService for callers that need it."""
        return self._node_service

    @property
    def recurrence_repo(self) -> TaskRecurrenceRepository:
        """Expose the recurrence repository."""
        return self._recurrence_repo

    @property
    def completion_repo(self) -> TaskCompletionRepository:
        """Expose the completion repository."""
        return self._completion_repo

    async def handle_status_change(
        self, node_id: int, status_line_id: int | None
    ) -> None:
        """Run all task automations for a task_status change.

        Args:
            node_id: The task node whose status changed.
            status_line_id: The newly selected task_status line ID, or None if
                the status value was cleared.
        """
        status_prop = await self._prop_repo.get_by_uuid(
            SYSTEM_PROPERTY_UUIDS["task_status"]
        )
        if not status_prop or status_prop.id is None:
            return

        status_name: str | None = None
        if status_line_id is not None:
            lines = await self._prop_repo.get_selection_lines(status_prop.id)
            selected_line = next(
                (line for line in lines if line.id == status_line_id), None
            )
            status_name = selected_line.name if selected_line else None

        await self._update_closed_date(node_id, status_name)
        if status_name in TASK_CLOSED_STATUSES:
            await self._handle_recurrence(node_id, status_prop, status_name)

    async def _update_closed_date(
        self, node_id: int, status_name: str | None
    ) -> None:
        """Set or clear task_closed_date based on the new status."""
        closed_date_prop = await self._prop_repo.get_by_uuid(
            SYSTEM_PROPERTY_UUIDS["task_closed_date"]
        )
        if not closed_date_prop or closed_date_prop.id is None:
            return

        if status_name in TASK_CLOSED_STATUSES:
            day_node = await self._node_service.get_or_create_day_node(date.today())
            if day_node and day_node.id is not None:
                await self._prop_repo.clear_relation_values(
                    node_id, closed_date_prop.id
                )
                await self._prop_repo.set_relation_value(
                    node_id, closed_date_prop.id, day_node.id
                )
        else:
            await self._prop_repo.clear_relation_values(
                node_id, closed_date_prop.id
            )

    async def _handle_recurrence(
        self,
        node_id: int,
        status_prop: Property,
        status_name: str,
    ) -> None:
        """Advance scheduled/deadline dates and reset status for recurring tasks."""
        rule = await self._recurrence_repo.get_by_task(node_id)
        if rule is None:
            # Fallback: try to derive a rule from the legacy selection property.
            rule = await self._rule_from_legacy_property(node_id)
            if rule is None:
                return

        if not rule.active:
            return

        # Capture the occurrence dates before they are advanced.
        scheduled_info = await self._get_date_value(node_id, "task_scheduled")
        deadline_info = await self._get_date_value(node_id, "task_deadline")

        # Record this completion.
        completion = TaskCompletion(
            task_node_id=node_id,
            workspace_id=self._node_service.workspace_id,
            scheduled_date=scheduled_info,
            deadline_date=deadline_info,
            status=status_name.lower(),
            completed_by=self._prop_repo.user_id,
        )
        await self._completion_repo.create(completion)

        completed_count = await self._completion_repo.count_by_task(node_id)

        advanced_any = False
        for date_prop_key in ("task_scheduled", "task_deadline"):
            current_date = await self._get_date_value(node_id, date_prop_key)
            if current_date is None:
                continue

            new_date = next_occurrence(current_date, rule)
            if new_date is None:
                continue

            if has_ended(rule, completed_count, new_date):
                continue

            new_day_node = await self._node_service.get_or_create_day_node(new_date)
            if new_day_node and new_day_node.id is not None:
                date_prop = await self._prop_repo.get_by_uuid(
                    SYSTEM_PROPERTY_UUIDS[date_prop_key]
                )
                if date_prop and date_prop.id is not None:
                    await self._prop_repo.clear_relation_values(node_id, date_prop.id)
                    await self._prop_repo.set_relation_value(
                        node_id, date_prop.id, new_day_node.id
                    )
                    advanced_any = True

        if not advanced_any:
            # The rule has ended (count or end date) so leave the task closed.
            return

        # Reset status to the configured default (usually "Pending").
        lines = await self._prop_repo.get_selection_lines(status_prop.id)
        default_line = next(
            (line for line in lines if line.name == TASK_DEFAULT_STATUS), None
        )
        if default_line and default_line.id is not None:
            await self._prop_repo.set_selection_value(
                node_id, status_prop.id, default_line.id
            )

        # Clear the closed date because the task is being reopened.
        closed_date_prop = await self._prop_repo.get_by_uuid(
            SYSTEM_PROPERTY_UUIDS["task_closed_date"]
        )
        if closed_date_prop and closed_date_prop.id is not None:
            await self._prop_repo.clear_relation_values(
                node_id, closed_date_prop.id
            )

    async def _get_date_value(self, node_id: int, property_key: str) -> date | None:
        """Resolve the date value for a date-type property, if set."""
        date_prop = await self._prop_repo.get_by_uuid(
            SYSTEM_PROPERTY_UUIDS[property_key]
        )
        if not date_prop or date_prop.id is None:
            return None

        existing_props = await self._prop_repo.get_all_property_values(node_id)
        if date_prop.id not in existing_props:
            return None

        date_values = existing_props[date_prop.id]
        if not date_values or not date_values.get("values"):
            return None

        value = date_values["values"][0]
        target_id = getattr(value, "target_id", None)
        if not target_id:
            return None

        target_node = await self._node_service.get_node(int(target_id))
        if not target_node or not target_node.uuid:
            return None

        return _uuid_to_date(target_node.uuid)

    async def _rule_from_legacy_property(
        self, node_id: int
    ) -> TaskRecurrence | None:
        """Build a transient TaskRecurrence from the legacy selection property."""
        recurrence_prop = await self._prop_repo.get_by_uuid(
            SYSTEM_PROPERTY_UUIDS["task_recurrence"]
        )
        if not recurrence_prop or recurrence_prop.id is None:
            return None

        existing_props = await self._prop_repo.get_all_property_values(node_id)
        if recurrence_prop.id not in existing_props:
            return None

        recurrence_values = existing_props[recurrence_prop.id]
        if not recurrence_values or not recurrence_values.get("values"):
            return None

        values = recurrence_values["values"]
        if not values:
            return None

        rec_id = getattr(values[0], "selection_line_id", None)
        if rec_id is None:
            return None

        rec_lines = await self._prop_repo.get_selection_lines(recurrence_prop.id)
        rec_line = next((line for line in rec_lines if line.id == rec_id), None)
        if not rec_line:
            return None

        reference_date = await self._get_date_value(node_id, "task_scheduled")
        if reference_date is None:
            reference_date = await self._get_date_value(node_id, "task_deadline")

        rule_data = _rule_data_for_option(rec_line.name, reference_date)
        if rule_data is None:
            return None

        return TaskRecurrence(
            task_node_id=node_id,
            workspace_id=self._node_service.workspace_id,
            **rule_data,
        )


def _rule_data_for_option(
    option_name: str, reference_date: date | None
) -> dict | None:
    """Map a legacy recurrence option name to rule kwargs."""
    reference = reference_date or date.today()
    option_map = {opt["name"]: opt for opt in TASK_RECURRENCE_OPTIONS}
    if option_name not in option_map:
        return None

    if option_name == "Daily":
        return {"rule_type": "daily", "interval": 1}
    if option_name == "Every Weekday":
        return {"rule_type": "weekday", "interval": 1}
    if option_name == "Weekly":
        return {"rule_type": "weekly", "interval": 1}
    if option_name == "Biweekly":
        return {"rule_type": "weekly", "interval": 2}
    if option_name == "Monthly":
        return {
            "rule_type": "monthly",
            "interval": 1,
            "day_of_month": reference.day,
        }
    if option_name == "Yearly":
        return {
            "rule_type": "yearly",
            "interval": 1,
            "month": reference.month,
            "day_of_month": reference.day,
        }
    return None


def _uuid_to_date(uuid_str: str) -> date | None:
    """Extract a date from a day page UUID.

    Day page UUID format: 00000000-0000-0000-00dd-YYYYMMDD0000
    """
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
