"""Task recurrence domain entity.

Represents a recurrence rule attached to a task node.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date

from ...utils import utc_now_iso
from .node import generate_uuid


@dataclass
class TaskRecurrence:
    """Recurrence rule for a task node.

    rule_type values:
        - "daily": repeat every interval days.
        - "weekday": repeat on weekdays only (Monday-Friday).
        - "weekly": repeat every interval weeks, optionally restricted to weekdays.
        - "monthly": repeat every interval months, on day_of_month or on a
          specific weekday of the month (week_of_month + weekdays).
        - "yearly": repeat every interval years, on month + day_of_month.
    """

    id: int | None = None
    uuid: str = field(default_factory=generate_uuid)
    task_node_id: int = 0
    workspace_id: int = 0
    rule_type: str = "daily"
    interval: int = 1
    weekdays: list[int] | None = None
    day_of_month: int | None = None
    week_of_month: int | None = None
    month: int | None = None
    end_after_count: int | None = None
    end_date: date | None = None
    active: bool = True
    create_date: str = field(default_factory=utc_now_iso)
    write_date: str = field(default_factory=utc_now_iso)
    create_uid: int | None = None
    write_uid: int | None = None

    def touch(self, user_id: int | None = None) -> None:
        """Update modification timestamp."""
        self.write_date = utc_now_iso()
        if user_id is not None:
            self.write_uid = user_id
