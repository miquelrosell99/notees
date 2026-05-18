"""Class extension entity."""
from __future__ import annotations

from typing import Optional
from dataclasses import dataclass


@dataclass
class ClassExtend:
    """Represents a class extension relationship."""
    id: int
    target_id: int  # The child class
    source_id: int  # The parent class being extended
    sequence: int
    source_name: str = ""
    source_icon: Optional[str] = None
