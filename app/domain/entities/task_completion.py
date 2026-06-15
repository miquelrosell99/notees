"""Task completion domain entity.

Represents one completed or skipped occurrence of a recurring task.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date, datetime

from ...utils import utc_now, utc_now_iso
from .node import generate_uuid


@dataclass
class TaskCompletion:
    """Historical record of a single recurring task occurrence."""

    id: int | None = None
    uuid: str = field(default_factory=generate_uuid)
    task_node_id: int = 0
    workspace_id: int = 0
    scheduled_date: date | None = None
    deadline_date: date | None = None
    status: str = "done"  # "done", "cancelled", or "skipped"
    completed_at: datetime = field(default_factory=utc_now)
    completed_by: int | None = None
    create_date: str = field(default_factory=utc_now_iso)

    def __post_init__(self):
        """Normalize status to lowercase on instantiation."""
        self.status = (self.status or "done").lower()
