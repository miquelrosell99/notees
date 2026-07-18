"""Replay ideal operations into a SQLite derived-state database.

This module is a thin integration wrapper around :mod:`app.core.derived`. It
preserves the historical import surface used by migration tests and scripts.
"""

from __future__ import annotations

from app.core.derived import (
    SCHEMA_SQL,
    apply_operation,
    create_derived_schema,
    replay_operations,
)

__all__ = [
    "SCHEMA_SQL",
    "apply_operation",
    "create_derived_schema",
    "replay_operations",
]
