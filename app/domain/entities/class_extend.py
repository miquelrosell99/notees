"""Class extension entity."""

from __future__ import annotations

from dataclasses import dataclass, field

from .node import generate_uuid


@dataclass
class ClassExtend:
    """Represents a class extension relationship."""

    id: int
    target_id: int  # The child class
    source_id: int  # The parent class being extended
    sequence: int
    uuid: str = field(default_factory=generate_uuid)
    source_name: str = ""
    source_icon: str | None = None
