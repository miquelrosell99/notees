"""Task automation service.

Encapsulates task lifecycle side effects (closed date and recurrence) that were
previously implemented directly in the properties router. Keeping this logic in
the domain layer preserves the hexagonal boundary and makes it testable without
HTTP scaffolding.
"""

from __future__ import annotations

import calendar
from datetime import date, timedelta
from typing import TYPE_CHECKING

from app.domain.entities import Property, TaskCompletion, TaskRecurrence
from app.domain.entities.constants import (
    SYSTEM_PROPERTY_UUIDS,
    TASK_CLOSED_STATUSES,
    TASK_DEFAULT_STATUS,
    TASK_RECURRENCE_OPTIONS,
)
from app.features.nodes.node_service import NodeService
from app.features.tasks.port import TaskCompletionRepository, TaskRecurrenceRepository

if TYPE_CHECKING:
    from app.features.properties.port import PropertyRepository


class TaskAutomationService:
    """Runs task lifecycle automations triggered by status changes."""

    def __init__(
        self,
        node_service: NodeService,
        property_repository: PropertyRepository,
        recurrence_repo: TaskRecurrenceRepository,
        completion_repo: TaskCompletionRepository,
        user_id: int | None = None,
    ) -> None:
        self._node_service = node_service
        self._prop_repo = property_repository
        self._recurrence_repo = recurrence_repo
        self._completion_repo = completion_repo
        self._user_id = user_id

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
            completed_by=self._user_id,
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


class RecurrenceError(ValueError):
    """Raised when a recurrence rule is invalid or cannot be applied."""

    pass


def next_occurrence(d: date, rule: TaskRecurrence) -> date | None:
    """Compute the next occurrence after ``d`` for the given rule.

    Returns ``None`` if the rule type is not supported or the resulting date
    would be invalid.
    """
    rule_type = rule.rule_type.lower()
    interval = max(1, rule.interval or 1)

    if rule_type == "daily":
        return d + timedelta(days=interval)

    if rule_type == "weekday":
        return _next_weekday(d)

    if rule_type == "weekly":
        return _next_weekly(d, interval, rule.weekdays)

    if rule_type == "monthly":
        return _next_monthly(d, interval, rule.day_of_month, rule.week_of_month, rule.weekdays)

    if rule_type == "yearly":
        return _next_yearly(d, interval, rule.month, rule.day_of_month)

    return None


def has_ended(rule: TaskRecurrence, completed_count: int, current_date: date) -> bool:
    """Return True if recurrence should stop based on count or end date."""
    if rule.end_after_count is not None and completed_count >= rule.end_after_count:
        return True
    return rule.end_date is not None and current_date > rule.end_date


def _next_weekday(d: date) -> date:
    """Return the next weekday after ``d`` (skip Saturday/Sunday)."""
    next_d = d + timedelta(days=1)
    while next_d.weekday() >= 5:  # 5 = Saturday, 6 = Sunday
        next_d += timedelta(days=1)
    return next_d


def _next_weekly(d: date, interval: int, weekdays: list[int] | None) -> date:
    """Return the next weekly occurrence after ``d``.

    If ``weekdays`` is provided (ISO weekdays, 1=Monday..7=Sunday), the next
    matching weekday in the upcoming weeks is returned. Otherwise the same
    weekday as ``d`` is used.
    """
    if not weekdays:
        return d + timedelta(weeks=interval)

    sorted_days = sorted(weekdays)
    # Search up to interval+1 weeks to find the next matching weekday.
    for week_offset in range(interval + 2):
        base = d + timedelta(weeks=week_offset)
        for day in sorted_days:
            candidate = _adjust_to_weekday(base, day)
            if candidate > d:
                # When week_offset is less than interval-1, only accept days
                # that are at least interval weeks away from the base date.
                weeks_apart = (candidate - d).days // 7
                if weeks_apart >= interval - 1:
                    return candidate
    # Fallback: same weekday as the base date, interval weeks later.
    return d + timedelta(weeks=interval)


def _adjust_to_weekday(d: date, target_iso_weekday: int) -> date:
    """Return the date of ``target_iso_weekday`` in the same week as ``d``.

    ISO weekday: Monday=1, Sunday=7.
    """
    # Python weekday: Monday=0, Sunday=6
    current_iso = d.isoweekday()
    delta = target_iso_weekday - current_iso
    return d + timedelta(days=delta)


def _next_monthly(
    d: date,
    interval: int,
    day_of_month: int | None,
    week_of_month: int | None,
    weekdays: list[int] | None,
) -> date:
    """Return the next monthly occurrence after ``d``."""
    if week_of_month is not None and weekdays:
        return _next_monthly_by_weekday(d, interval, week_of_month, weekdays)

    target_day = day_of_month if day_of_month is not None else d.day
    year, month = _add_months(d.year, d.month, interval)
    last_day = calendar.monthrange(year, month)[1]
    safe_day = min(target_day, last_day)
    return date(year, month, safe_day)


def _next_monthly_by_weekday(
    d: date, interval: int, week_of_month: int, weekdays: list[int]
) -> date:
    """Return the Nth weekday of the target month (e.g. last Friday).

    ``week_of_month`` uses positive values 1-4 for the first-fourth occurrence,
    and -1 for the last occurrence.
    """
    year, month = _add_months(d.year, d.month, interval)
    sorted_days = sorted(weekdays)

    candidates: list[date] = []
    for target_day in sorted_days:
        candidate = _nth_weekday_of_month(year, month, target_day, week_of_month)
        if candidate is not None:
            candidates.append(candidate)

    if not candidates:
        # Fallback to the last matching weekday of the month.
        candidate = _nth_weekday_of_month(year, month, sorted_days[0], -1)
        if candidate is not None:
            return candidate
        raise RecurrenceError("Could not resolve monthly recurrence by weekday")

    return min(candidates)


def _nth_weekday_of_month(year: int, month: int, iso_weekday: int, n: int) -> date | None:
    """Return the Nth occurrence of ``iso_weekday`` in the given month.

    ``n`` > 0 counts from the start of the month; ``n`` == -1 returns the last
    occurrence. Returns None if it does not exist.
    """
    last_day = calendar.monthrange(year, month)[1]
    matches = [
        date(year, month, day)
        for day in range(1, last_day + 1)
        if date(year, month, day).isoweekday() == iso_weekday
    ]
    if not matches:
        return None
    if n == -1:
        return matches[-1]
    if n > 0 and n <= len(matches):
        return matches[n - 1]
    return None


def _next_yearly(d: date, interval: int, month: int | None, day_of_month: int | None) -> date:
    """Return the next yearly occurrence after ``d``."""
    target_month = month if month is not None else d.month
    target_day = day_of_month if day_of_month is not None else d.day
    year = d.year + interval
    last_day = calendar.monthrange(year, target_month)[1]
    safe_day = min(target_day, last_day)
    return date(year, target_month, safe_day)


def _add_months(year: int, month: int, months: int) -> tuple[int, int]:
    """Add ``months`` to (year, month), wrapping December to January."""
    total = year * 12 + (month - 1) + months
    return divmod(total, 12)[0], divmod(total, 12)[1] + 1


def describe_rule(rule: TaskRecurrence) -> str:
    """Return a human-readable description of a recurrence rule."""
    rule_type = rule.rule_type.lower()
    interval = rule.interval or 1

    if rule_type == "daily":
        return "Daily" if interval == 1 else f"Every {interval} days"

    if rule_type == "weekday":
        return "Every weekday"

    if rule_type == "weekly":
        if rule.weekdays:
            names = [_weekday_name(d) for d in sorted(rule.weekdays)]
            days = ", ".join(names)
            return f"Every {interval} week(s) on {days}" if interval != 1 else f"Weekly on {days}"
        return "Weekly" if interval == 1 else f"Every {interval} weeks"

    if rule_type == "monthly":
        if rule.week_of_month is not None and rule.weekdays:
            ordinal = _ordinal_name(rule.week_of_month)
            day = _weekday_name(rule.weekdays[0])
            base = f"{ordinal} {day} of every {interval} month(s)"
            return base.replace("every 1 month(s)", "every month")
        day = rule.day_of_month or 1
        base = f"Monthly on day {day}"
        if interval != 1:
            base += f" every {interval} months"
        return base

    if rule_type == "yearly":
        month_name = calendar.month_name[rule.month] if rule.month else ""
        day = rule.day_of_month or 1
        return f"Yearly on {month_name} {day}"

    return "Custom"


def _weekday_name(iso_weekday: int) -> str:
    return calendar.day_name[iso_weekday - 1]


def _ordinal_name(n: int) -> str:
    if n == -1:
        return "last"
    if 11 <= n % 100 <= 13:
        return f"{n}th"
    return f"{n}{['th', 'st', 'nd', 'rd', 'th'][min(n % 10, 4)]}"
