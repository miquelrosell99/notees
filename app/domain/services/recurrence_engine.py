"""Pure recurrence date computation.

No database access; operates only on ``TaskRecurrence`` entities and Python
``date`` objects.
"""

from __future__ import annotations

import calendar
from datetime import date, timedelta
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from ..entities import TaskRecurrence


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
